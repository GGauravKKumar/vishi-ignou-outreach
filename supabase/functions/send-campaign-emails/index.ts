import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { SMTPClient } from "https://deno.land/x/denomailer@1.6.0/mod.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

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

const personalizeContent = (content: string, recipient: Recipient): string => {
  return content
    .replace(/\{\{name\}\}/gi, recipient.name)
    .replace(/\{\{email\}\}/gi, recipient.email)
    .replace(/\{\{course\}\}/gi, recipient.course);
};

const normalizeCRLF = (content: string): string => {
  return content.replace(/\r?\n/g, "\r\n");
};

const isValidEmail = (email: string): boolean => {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
};

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Reduced retry attempts for faster processing
const MAX_RETRIES = 2;
const RETRY_DELAYS = [500, 1500];

// CRITICAL: Smaller chunk size to avoid CPU timeout (max ~20 emails per invocation)
const CHUNK_SIZE = 20;
// Process emails sequentially to minimize CPU spikes
const BATCH_SIZE = 1;

// 2 minute timeout for individual email send operations
const EMAIL_TIMEOUT_MS = 2 * 60 * 1000;

// Wrapper to add timeout to any promise
function withTimeout<T>(promise: Promise<T>, ms: number, errorMessage: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => 
      setTimeout(() => reject(new Error(errorMessage)), ms)
    )
  ]);
}

async function sendEmailWithRetry(
  client: SMTPClient,
  emailConfig: { from: string; to: string; subject: string; content: string; html: string },
  recipientEmail: string
): Promise<{ success: boolean; error?: string }> {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      // Add 2 minute timeout to email send operation
      await withTimeout(
        client.send(emailConfig),
        EMAIL_TIMEOUT_MS,
        `Email send timed out after 2 minutes for ${recipientEmail}`
      );
      return { success: true };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      console.log(`[Retry] Attempt ${attempt + 1}/${MAX_RETRIES} failed for ${recipientEmail}: ${errorMessage}`);
      
      // Permanent failures - don't retry
      if (errorMessage.includes("550") || errorMessage.includes("553") || errorMessage.includes("invalid")) {
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

// Process a chunk of emails (designed to complete within CPU limits)
async function processEmailChunk(
  supabaseUrl: string,
  supabaseServiceKey: string,
  campaignId: string,
  template: { subject: string; body: string },
  recipients: Recipient[],
  smtpConfig: { host: string; username: string; from_name: string; from_email: string },
  smtpPassword: string,
  chunkIndex: number,
  totalChunks: number
) {
  const supabase = createClient(supabaseUrl, supabaseServiceKey);
  console.log(`[Chunk ${chunkIndex + 1}/${totalChunks}] Processing ${recipients.length} emails`);
  
  let sentCount = 0;
  let failedCount = 0;

  // Validate emails
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
  }

  let smtpClient: SMTPClient | null = null;
  
  try {
    smtpClient = new SMTPClient({
      connection: {
        hostname: smtpConfig.host,
        port: 465,
        tls: true,
        auth: {
          username: smtpConfig.username,
          password: smtpPassword,
        },
      },
    });
    console.log(`[Chunk ${chunkIndex + 1}] SMTP connected`);

    // Process emails SEQUENTIALLY to minimize CPU usage
    for (const recipient of validRecipients) {
      const personalizedSubject = personalizeContent(template.subject, recipient) || "No Subject";
      const personalizedBody = personalizeContent(template.body, recipient);
      const normalizedBody = normalizeCRLF(personalizedBody);
      const normalizedSubject = normalizeCRLF(personalizedSubject);
      const htmlBody = normalizedBody.replace(/\r\n/g, "<br>");

      // Ensure subject is never empty
      const finalSubject = normalizedSubject.trim() || "No Subject";
      const fromAddress = `${smtpConfig.from_name} <${smtpConfig.from_email}>`;
      
      const emailConfig = {
        from: fromAddress,
        to: recipient.email,
        subject: finalSubject,
        content: normalizedBody,
        html: htmlBody,
        headers: {
          "From": fromAddress,
          "To": recipient.email,
          "Subject": finalSubject,
          "MIME-Version": "1.0",
          "Content-Type": "text/html; charset=UTF-8",
        },
      };

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
        console.log(`[Chunk ${chunkIndex + 1}] ✗ ${recipient.email}`);
      }

      // Update campaign progress after each email
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

      // Small delay to spread CPU
      await delay(100);
    }
  } catch (connectionError) {
    console.error(`[Chunk ${chunkIndex + 1}] SMTP error:`, connectionError);
    for (const recipient of validRecipients.slice(sentCount)) {
      await supabase
        .from("email_logs")
        .update({ 
          status: "failed", 
          error_message: `SMTP error: ${connectionError instanceof Error ? connectionError.message : "Unknown"}`
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
      } catch (e) {
        console.error("Error closing SMTP:", e);
      }
    }
  }

  console.log(`[Chunk ${chunkIndex + 1}] Complete: ${sentCount} sent, ${failedCount} failed`);
  return { sentCount, failedCount };
}

// Trigger next chunk via self-invocation
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
  
  // Use supabase.functions.invoke for self-invocation
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

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const smtpPassword = Deno.env.get("SMTP_PASSWORD");

    if (!smtpPassword) {
      return new Response(
        JSON.stringify({ error: "SMTP password not configured" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey);
    const { campaignId, template, recipients, isRetry, chunkIndex, totalChunks }: EmailRequest = await req.json();
    
    const isChunkedCall = typeof chunkIndex === 'number' && typeof totalChunks === 'number';
    console.log(`Received: campaign=${campaignId}, recipients=${recipients.length}, chunk=${chunkIndex ?? 'initial'}/${totalChunks ?? 'N/A'}`);

    if (recipients.length === 0) {
      return new Response(
        JSON.stringify({ error: "No recipients provided" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const { data: smtpConfig, error: smtpError } = await supabase
      .from("smtp_config")
      .select("*")
      .limit(1)
      .single();

    if (smtpError || !smtpConfig) {
      return new Response(
        JSON.stringify({ error: "SMTP configuration not found" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // If this is a chunked call, process the chunk
    if (isChunkedCall) {
      // Process this chunk in background
      // @ts-ignore
      EdgeRuntime.waitUntil((async () => {
        await processEmailChunk(
          supabaseUrl, supabaseServiceKey, campaignId, template, recipients,
          smtpConfig, smtpPassword, chunkIndex!, totalChunks!
        );

        // Check if more chunks needed
        if (chunkIndex! + 1 < totalChunks!) {
          // Calculate remaining recipients for next chunks
          const { data: pendingLogs } = await supabase
            .from("email_logs")
            .select("student_id, recipient_email, recipient_name")
            .eq("campaign_id", campaignId)
            .eq("status", "pending");
          
          if (pendingLogs && pendingLogs.length > 0) {
            // Get student details for pending emails
            const { data: students } = await supabase
              .from("students")
              .select("id, name, email, course")
              .in("id", pendingLogs.map(l => l.student_id).filter(Boolean));
            
            if (students && students.length > 0) {
              const nextChunkRecipients = students.slice(0, CHUNK_SIZE);
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

    // INITIAL CALL: Split into chunks and start first chunk
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

    // Process first chunk in background and chain to next
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
        chunks: calculatedTotalChunks
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Campaign error:", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
