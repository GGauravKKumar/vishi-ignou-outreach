import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { SMTPClient } from "https://deno.land/x/denomailer@1.6.0/mod.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// ============================================================================
// RFC 5322 COMPLIANT EMAIL SERVICE
// ============================================================================
// This module enforces strict RFC 5322 compliance for Gmail deliverability:
// - Mandatory headers: From, To, Subject, Date, Message-ID
// - Proper MIME formatting
// - Subject validation (blocks empty subjects)
// - Email address validation
// ============================================================================

interface Recipient {
  id: string;
  name: string;
  email: string;
  course: string;
}

interface EmailRequest {
  campaignId: string;
  template: {
    subject: string;
    body: string;
  };
  recipients: Recipient[];
  isRetry?: boolean;
  chunkIndex?: number;
  totalChunks?: number;
}

interface SmtpConfig {
  host: string;
  port: number;
  username: string;
  from_name: string;
  from_email: string;
}

interface EmailValidationResult {
  valid: boolean;
  errors: string[];
}

// ============================================================================
// EMAIL VALIDATION UTILITIES
// ============================================================================

/**
 * Validates email address format per RFC 5322
 */
function isValidEmail(email: string): boolean {
  if (!email || typeof email !== 'string') return false;
  const emailRegex = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
  return emailRegex.test(email.trim()) && email.length <= 254;
}

/**
 * Validates subject line - blocks empty subjects
 */
function isValidSubject(subject: string): boolean {
  if (!subject || typeof subject !== 'string') return false;
  const trimmed = subject.trim();
  return trimmed.length > 0 && trimmed.length <= 998; // RFC 5322 line limit
}

/**
 * Validates From address
 */
function isValidFromAddress(fromName: string, fromEmail: string): boolean {
  if (!fromEmail || !isValidEmail(fromEmail)) return false;
  return true;
}

/**
 * Comprehensive email validation before sending
 */
function validateEmailConfig(
  fromName: string,
  fromEmail: string,
  toEmail: string,
  subject: string
): EmailValidationResult {
  const errors: string[] = [];

  if (!isValidFromAddress(fromName, fromEmail)) {
    errors.push(`Invalid From address: ${fromEmail}`);
  }

  if (!isValidEmail(toEmail)) {
    errors.push(`Invalid To address: ${toEmail}`);
  }

  if (!isValidSubject(subject)) {
    errors.push(`Invalid or empty Subject: "${subject}"`);
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

/**
 * Generates RFC 5322 compliant Message-ID
 */
function generateMessageId(domain: string): string {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 15);
  return `<${timestamp}.${random}@${domain}>`;
}

/**
 * Formats RFC 5322 compliant Date header
 */
function formatRFC5322Date(): string {
  const now = new Date();
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  
  const dayName = days[now.getUTCDay()];
  const day = now.getUTCDate().toString().padStart(2, '0');
  const month = months[now.getUTCMonth()];
  const year = now.getUTCFullYear();
  const hours = now.getUTCHours().toString().padStart(2, '0');
  const minutes = now.getUTCMinutes().toString().padStart(2, '0');
  const seconds = now.getUTCSeconds().toString().padStart(2, '0');
  
  return `${dayName}, ${day} ${month} ${year} ${hours}:${minutes}:${seconds} +0000`;
}

/**
 * Extracts domain from email address
 */
function extractDomain(email: string): string {
  const parts = email.split('@');
  return parts.length > 1 ? parts[1] : 'localhost';
}

/**
 * Encodes subject for RFC 2047 (handles special characters)
 */
function encodeSubjectRFC2047(subject: string): string {
  // Check if subject contains non-ASCII characters
  const hasNonAscii = /[^\x00-\x7F]/.test(subject);
  if (hasNonAscii) {
    // Use Base64 encoding for non-ASCII
    const encoded = btoa(unescape(encodeURIComponent(subject)));
    return `=?UTF-8?B?${encoded}?=`;
  }
  return subject;
}

// ============================================================================
// CONTENT PROCESSING
// ============================================================================

const personalizeContent = (content: string, recipient: Recipient): string => {
  if (!content) return '';
  return content
    .replace(/\{\{name\}\}/gi, recipient.name || '')
    .replace(/\{\{email\}\}/gi, recipient.email || '')
    .replace(/\{\{course\}\}/gi, recipient.course || '');
};

const normalizeCRLF = (content: string): string => {
  if (!content) return '';
  return content.replace(/\r?\n/g, "\r\n");
};

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// ============================================================================
// CONFIGURATION
// ============================================================================

const MAX_RETRIES = 2;
const RETRY_DELAYS = [500, 1500];
const CHUNK_SIZE = 20;
const EMAIL_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes

// ============================================================================
// TIMEOUT WRAPPER
// ============================================================================

function withTimeout<T>(promise: Promise<T>, ms: number, errorMessage: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => 
      setTimeout(() => reject(new Error(errorMessage)), ms)
    )
  ]);
}

// ============================================================================
// EMAIL SENDING WITH RETRY
// ============================================================================

interface RFC5322EmailConfig {
  from: string;
  to: string;
  subject: string;
  content: string;
  html: string;
  date: string;
  messageId: string;
  mimeVersion: string;
}

async function sendEmailWithRetry(
  client: SMTPClient,
  emailConfig: RFC5322EmailConfig,
  recipientEmail: string
): Promise<{ success: boolean; error?: string }> {
  
  // Log the email configuration for debugging
  console.log(`[Email] Sending to ${recipientEmail} with From: ${emailConfig.from}, Subject: ${emailConfig.subject.substring(0, 50)}...`);
  
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      // Build the email with all RFC 5322 required headers
      // The denomailer library requires these fields in a specific format
      await withTimeout(
        client.send({
          from: emailConfig.from,
          to: emailConfig.to,
          subject: emailConfig.subject,
          content: emailConfig.content,
          html: emailConfig.html,
          // Additional headers passed through the library's mechanism
          date: emailConfig.date,
          headers: {
            "Message-ID": emailConfig.messageId,
            "MIME-Version": emailConfig.mimeVersion,
            "X-Mailer": "Campaign-Mailer/1.0",
          }
        }),
        EMAIL_TIMEOUT_MS,
        `Email send timed out after 2 minutes for ${recipientEmail}`
      );
      
      console.log(`[Email] ✓ Successfully sent to ${recipientEmail}`);
      return { success: true };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      console.log(`[Retry] Attempt ${attempt + 1}/${MAX_RETRIES} failed for ${recipientEmail}: ${errorMessage}`);
      
      // Permanent failures - don't retry
      if (errorMessage.includes("550") || errorMessage.includes("553") || errorMessage.includes("invalid") || errorMessage.includes("RFC")) {
        return { success: false, error: `Permanent failure: ${errorMessage}` };
      }
      
      // Timeout - skip after one retry
      if (errorMessage.includes("timed out")) {
        if (attempt === 0) {
          console.log(`[Timeout] Retrying ${recipientEmail} once after timeout`);
          await delay(1000);
          continue;
        }
        return { success: false, error: `Skipped: ${errorMessage}` };
      }
      
      if (attempt < MAX_RETRIES - 1) {
        await delay(RETRY_DELAYS[attempt]);
      } else {
        return { success: false, error: errorMessage };
      }
    }
  }
  return { success: false, error: "Max retries exceeded" };
}

// ============================================================================
// CHUNK PROCESSING
// ============================================================================

async function processEmailChunk(
  supabaseUrl: string,
  supabaseServiceKey: string,
  campaignId: string,
  template: { subject: string; body: string },
  recipients: Recipient[],
  smtpConfig: SmtpConfig,
  smtpPassword: string,
  chunkIndex: number,
  totalChunks: number
) {
  const supabase = createClient(supabaseUrl, supabaseServiceKey);
  console.log(`[Chunk ${chunkIndex + 1}/${totalChunks}] Processing ${recipients.length} emails`);
  
  let sentCount = 0;
  let failedCount = 0;

  // Validate SMTP config
  if (!isValidFromAddress(smtpConfig.from_name, smtpConfig.from_email)) {
    console.error(`[Chunk ${chunkIndex + 1}] Invalid From address in SMTP config: ${smtpConfig.from_email}`);
    // Mark all as failed
    for (const recipient of recipients) {
      await supabase
        .from("email_logs")
        .update({ status: "failed", error_message: "Invalid From address configuration" })
        .eq("campaign_id", campaignId)
        .eq("student_id", recipient.id);
    }
    return { sentCount: 0, failedCount: recipients.length };
  }

  // Validate template subject
  if (!isValidSubject(template.subject)) {
    console.error(`[Chunk ${chunkIndex + 1}] BLOCKING: Empty or invalid subject in template`);
    for (const recipient of recipients) {
      await supabase
        .from("email_logs")
        .update({ status: "failed", error_message: "Email blocked: Empty subject not allowed" })
        .eq("campaign_id", campaignId)
        .eq("student_id", recipient.id);
      
      // Update campaign counts
      const { data: currentCampaign } = await supabase
        .from("campaigns")
        .select("failed_count, pending_count")
        .eq("id", campaignId)
        .single();
      
      if (currentCampaign) {
        await supabase
          .from("campaigns")
          .update({ 
            failed_count: (currentCampaign.failed_count || 0) + 1,
            pending_count: Math.max(0, (currentCampaign.pending_count || 0) - 1)
          })
          .eq("id", campaignId);
      }
    }
    return { sentCount: 0, failedCount: recipients.length };
  }

  // Separate valid and invalid recipients
  const validRecipients: Recipient[] = [];
  const invalidRecipients: Recipient[] = [];
  
  for (const recipient of recipients) {
    if (isValidEmail(recipient.email)) {
      validRecipients.push(recipient);
    } else {
      invalidRecipients.push(recipient);
    }
  }
  
  // Mark invalid emails
  for (const recipient of invalidRecipients) {
    await supabase
      .from("email_logs")
      .update({ status: "failed", error_message: "Invalid email format" })
      .eq("campaign_id", campaignId)
      .eq("student_id", recipient.id);
    failedCount++;
    
    // Update campaign counts
    const { data: currentCampaign } = await supabase
      .from("campaigns")
      .select("failed_count, pending_count")
      .eq("id", campaignId)
      .single();
    
    if (currentCampaign) {
      await supabase
        .from("campaigns")
        .update({ 
          failed_count: (currentCampaign.failed_count || 0) + 1,
          pending_count: Math.max(0, (currentCampaign.pending_count || 0) - 1)
        })
        .eq("id", campaignId);
    }
  }

  if (validRecipients.length === 0) {
    console.log(`[Chunk ${chunkIndex + 1}] No valid recipients to process`);
    return { sentCount, failedCount };
  }

  let smtpClient: SMTPClient | null = null;
  const fromDomain = extractDomain(smtpConfig.from_email);
  
  try {
    // Connect with authenticated SMTP
    smtpClient = new SMTPClient({
      connection: {
        hostname: smtpConfig.host,
        port: smtpConfig.port || 465,
        tls: true,
        auth: {
          username: smtpConfig.username,
          password: smtpPassword,
        },
      },
    });
    console.log(`[Chunk ${chunkIndex + 1}] SMTP connected to ${smtpConfig.host}:${smtpConfig.port || 465} (TLS)`);

    // Process emails SEQUENTIALLY
    for (const recipient of validRecipients) {
      // Personalize content
      const personalizedSubject = personalizeContent(template.subject, recipient);
      const personalizedBody = personalizeContent(template.body, recipient);
      
      // Final validation of personalized subject
      if (!isValidSubject(personalizedSubject)) {
        console.log(`[Chunk ${chunkIndex + 1}] BLOCKING: Empty subject after personalization for ${recipient.email}`);
        await supabase
          .from("email_logs")
          .update({ status: "failed", error_message: "Email blocked: Subject became empty after personalization" })
          .eq("campaign_id", campaignId)
          .eq("student_id", recipient.id);
        failedCount++;
        continue;
      }

      // Normalize content
      const normalizedBody = normalizeCRLF(personalizedBody);
      const htmlBody = normalizedBody.replace(/\r\n/g, "<br>");

      // Build RFC 5322 compliant From address
      // Format: "Display Name" <email@domain.com>
      const fromAddress = smtpConfig.from_name 
        ? `"${smtpConfig.from_name.replace(/"/g, '\\"')}" <${smtpConfig.from_email}>`
        : smtpConfig.from_email;

      // Build RFC 5322 compliant email config
      const emailConfig: RFC5322EmailConfig = {
        from: fromAddress,
        to: recipient.email,
        subject: encodeSubjectRFC2047(personalizedSubject.trim()),
        content: normalizedBody,
        html: htmlBody,
        date: formatRFC5322Date(),
        messageId: generateMessageId(fromDomain),
        mimeVersion: "1.0"
      };

      // Validate complete email configuration
      const validation = validateEmailConfig(
        smtpConfig.from_name,
        smtpConfig.from_email,
        recipient.email,
        personalizedSubject
      );

      if (!validation.valid) {
        console.log(`[Chunk ${chunkIndex + 1}] Validation failed for ${recipient.email}: ${validation.errors.join(', ')}`);
        await supabase
          .from("email_logs")
          .update({ status: "failed", error_message: `Validation: ${validation.errors.join(', ')}` })
          .eq("campaign_id", campaignId)
          .eq("student_id", recipient.id);
        failedCount++;
        
        const { data: currentCampaign } = await supabase
          .from("campaigns")
          .select("failed_count, pending_count")
          .eq("id", campaignId)
          .single();
        
        if (currentCampaign) {
          await supabase
            .from("campaigns")
            .update({ 
              failed_count: (currentCampaign.failed_count || 0) + 1,
              pending_count: Math.max(0, (currentCampaign.pending_count || 0) - 1)
            })
            .eq("id", campaignId);
        }
        continue;
      }

      // Send email with retry
      const result = await sendEmailWithRetry(smtpClient, emailConfig, recipient.email);
      
      if (result.success) {
        await supabase
          .from("email_logs")
          .update({ status: "sent", sent_at: new Date().toISOString(), error_message: null })
          .eq("campaign_id", campaignId)
          .eq("student_id", recipient.id);
        sentCount++;
        console.log(`[Chunk ${chunkIndex + 1}] ✓ ${recipient.email}`);
      } else {
        await supabase
          .from("email_logs")
          .update({ status: "failed", error_message: result.error || "Unknown error" })
          .eq("campaign_id", campaignId)
          .eq("student_id", recipient.id);
        failedCount++;
        console.log(`[Chunk ${chunkIndex + 1}] ✗ ${recipient.email}: ${result.error}`);
      }

      // Update campaign progress
      const { data: currentCampaign } = await supabase
        .from("campaigns")
        .select("sent_count, failed_count, pending_count")
        .eq("id", campaignId)
        .single();
      
      if (currentCampaign) {
        await supabase
          .from("campaigns")
          .update({ 
            sent_count: (currentCampaign.sent_count || 0) + (result.success ? 1 : 0),
            failed_count: (currentCampaign.failed_count || 0) + (result.success ? 0 : 1),
            pending_count: Math.max(0, (currentCampaign.pending_count || 0) - 1)
          })
          .eq("id", campaignId);
      }

      // Small delay between emails
      await delay(100);
    }
  } catch (connectionError) {
    console.error(`[Chunk ${chunkIndex + 1}] SMTP connection error:`, connectionError);
    for (const recipient of validRecipients.slice(sentCount)) {
      await supabase
        .from("email_logs")
        .update({ 
          status: "failed", 
          error_message: `SMTP error: ${connectionError instanceof Error ? connectionError.message : "Connection failed"}`
        })
        .eq("campaign_id", campaignId)
        .eq("student_id", recipient.id)
        .eq("status", "pending");
      failedCount++;
    }
  } finally {
    if (smtpClient) {
      try {
        await smtpClient.close();
        console.log(`[Chunk ${chunkIndex + 1}] SMTP connection closed`);
      } catch (e) {
        console.error("Error closing SMTP:", e);
      }
    }
  }

  console.log(`[Chunk ${chunkIndex + 1}] Complete: ${sentCount} sent, ${failedCount} failed`);
  return { sentCount, failedCount };
}

// ============================================================================
// CHUNK SCHEDULING
// ============================================================================

async function triggerNextChunk(
  supabaseUrl: string,
  supabaseServiceKey: string,
  campaignId: string,
  template: { subject: string; body: string },
  allRecipients: Recipient[],
  currentChunk: number,
  totalChunks: number
) {
  const nextChunk = currentChunk + 1;
  if (nextChunk >= totalChunks) {
    console.log(`[Scheduler] All chunks complete for campaign ${campaignId}`);
    return;
  }

  const startIdx = nextChunk * CHUNK_SIZE;
  const chunkRecipients = allRecipients.slice(startIdx, startIdx + CHUNK_SIZE);
  
  console.log(`[Scheduler] Triggering chunk ${nextChunk + 1}/${totalChunks} with ${chunkRecipients.length} recipients`);

  const supabase = createClient(supabaseUrl, supabaseServiceKey);
  
  try {
    await supabase.functions.invoke('send-campaign-emails', {
      body: {
        campaignId,
        template,
        recipients: chunkRecipients,
        chunkIndex: nextChunk,
        totalChunks,
        isRetry: false
      }
    });
  } catch (error) {
    console.error(`[Scheduler] Failed to trigger next chunk:`, error);
  }
}

// ============================================================================
// MAIN HTTP HANDLER
// ============================================================================

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const smtpPassword = Deno.env.get("SMTP_PASSWORD");

    if (!smtpPassword) {
      console.error("[Error] SMTP password not configured");
      return new Response(
        JSON.stringify({ error: "SMTP password not configured" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey);
    const { campaignId, template, recipients, isRetry, chunkIndex, totalChunks }: EmailRequest = await req.json();
    
    console.log(`[Request] Campaign: ${campaignId}, Recipients: ${recipients.length}, Chunk: ${chunkIndex ?? 'initial'}/${totalChunks ?? 'N/A'}`);

    // ========== VALIDATION BEFORE SENDING ==========
    
    // Validate template subject BEFORE processing
    if (!template || !isValidSubject(template.subject)) {
      console.error(`[Error] BLOCKING CAMPAIGN: Empty or invalid template subject`);
      
      // Mark campaign as failed
      await supabase
        .from("campaigns")
        .update({ 
          status: "failed",
          sent_at: new Date().toISOString()
        })
        .eq("id", campaignId);
      
      return new Response(
        JSON.stringify({ error: "Campaign blocked: Template subject cannot be empty" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (recipients.length === 0) {
      return new Response(
        JSON.stringify({ error: "No recipients provided" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Get SMTP config
    const { data: smtpConfig, error: smtpError } = await supabase
      .from("smtp_config")
      .select("*")
      .limit(1)
      .single();

    if (smtpError || !smtpConfig) {
      console.error("[Error] SMTP configuration not found:", smtpError);
      return new Response(
        JSON.stringify({ error: "SMTP configuration not found" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Validate SMTP From address
    if (!isValidFromAddress(smtpConfig.from_name, smtpConfig.from_email)) {
      console.error(`[Error] Invalid From address in SMTP config: ${smtpConfig.from_email}`);
      return new Response(
        JSON.stringify({ error: "Invalid From email address in SMTP configuration" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log(`[Config] SMTP: ${smtpConfig.host}, From: "${smtpConfig.from_name}" <${smtpConfig.from_email}>`);

    const isChunkedCall = typeof chunkIndex === 'number' && typeof totalChunks === 'number';

    // ========== CHUNKED CALL PROCESSING ==========
    if (isChunkedCall) {
      // @ts-ignore
      EdgeRuntime.waitUntil((async () => {
        await processEmailChunk(
          supabaseUrl, supabaseServiceKey, campaignId, template, recipients,
          smtpConfig, smtpPassword, chunkIndex!, totalChunks!
        );

        // Check if more chunks needed
        if (chunkIndex! + 1 < totalChunks!) {
          const { data: pendingLogs } = await supabase
            .from("email_logs")
            .select("student_id")
            .eq("campaign_id", campaignId)
            .eq("status", "pending");
          
          if (pendingLogs && pendingLogs.length > 0) {
            const { data: students } = await supabase
              .from("students")
              .select("id, name, email, course")
              .in("id", pendingLogs.map(l => l.student_id).filter(Boolean));
            
            if (students && students.length > 0) {
              await triggerNextChunk(
                supabaseUrl, supabaseServiceKey, campaignId, template,
                students, chunkIndex!, Math.ceil(students.length / CHUNK_SIZE) + chunkIndex! + 1
              );
            }
          }
        }

        // Check if campaign is complete
        const { data: campaign } = await supabase
          .from("campaigns")
          .select("pending_count, sent_count, failed_count, total_recipients")
          .eq("id", campaignId)
          .single();
        
        if (campaign && campaign.pending_count === 0) {
          const finalStatus = campaign.failed_count === campaign.total_recipients ? "failed" : 
                             campaign.sent_count === campaign.total_recipients ? "sent" : "partial";
          await supabase
            .from("campaigns")
            .update({ status: finalStatus, sent_at: new Date().toISOString() })
            .eq("id", campaignId);
          console.log(`[Complete] Campaign ${campaignId} finished with status: ${finalStatus}`);
        }
      })());

      return new Response(
        JSON.stringify({ success: true, message: `Processing chunk ${chunkIndex! + 1}/${totalChunks}` }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ========== INITIAL CALL - SPLIT INTO CHUNKS ==========
    const calculatedTotalChunks = Math.ceil(recipients.length / CHUNK_SIZE);
    const firstChunkRecipients = recipients.slice(0, CHUNK_SIZE);
    
    console.log(`[Initial] Splitting ${recipients.length} recipients into ${calculatedTotalChunks} chunks of ${CHUNK_SIZE}`);

    // Set initial campaign status
    await supabase
      .from("campaigns")
      .update({ 
        status: "sending",
        pending_count: recipients.length,
        sent_count: isRetry ? undefined : 0,
        failed_count: isRetry ? undefined : 0
      })
      .eq("id", campaignId);

    // Process first chunk in background
    // @ts-ignore
    EdgeRuntime.waitUntil((async () => {
      await processEmailChunk(
        supabaseUrl, supabaseServiceKey, campaignId, template, firstChunkRecipients,
        smtpConfig, smtpPassword, 0, calculatedTotalChunks
      );

      // Trigger next chunk if needed
      if (calculatedTotalChunks > 1) {
        const nextRecipients = recipients.slice(CHUNK_SIZE, CHUNK_SIZE * 2);
        if (nextRecipients.length > 0) {
          await supabase.functions.invoke('send-campaign-emails', {
            body: {
              campaignId,
              template,
              recipients: nextRecipients,
              chunkIndex: 1,
              totalChunks: calculatedTotalChunks,
              isRetry: false
            }
          });
        }
      } else {
        // Only one chunk, finalize
        const { data: campaign } = await supabase
          .from("campaigns")
          .select("pending_count, sent_count, failed_count, total_recipients")
          .eq("id", campaignId)
          .single();
        
        if (campaign && campaign.pending_count === 0) {
          const finalStatus = campaign.failed_count === campaign.total_recipients ? "failed" : 
                             campaign.sent_count === campaign.total_recipients ? "sent" : "partial";
          await supabase
            .from("campaigns")
            .update({ status: finalStatus, sent_at: new Date().toISOString() })
            .eq("id", campaignId);
        }
      }
    })());

    return new Response(
      JSON.stringify({ 
        success: true, 
        message: `Campaign started. Processing ${recipients.length} emails in ${calculatedTotalChunks} chunks.`,
        totalRecipients: recipients.length,
        chunks: calculatedTotalChunks,
        smtpFrom: `${smtpConfig.from_name} <${smtpConfig.from_email}>`
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("[Error] Campaign error:", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});