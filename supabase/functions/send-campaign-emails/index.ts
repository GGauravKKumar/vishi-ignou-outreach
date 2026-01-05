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
}

const personalizeContent = (content: string, recipient: Recipient): string => {
  return content
    .replace(/\{\{name\}\}/gi, recipient.name)
    .replace(/\{\{email\}\}/gi, recipient.email)
    .replace(/\{\{course\}\}/gi, recipient.course);
};

// Convert bare LF to CRLF for RFC 822 compliance
const normalizeCRLF = (content: string): string => {
  return content.replace(/\r?\n/g, "\r\n");
};

// Email validation regex
const isValidEmail = (email: string): boolean => {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
};

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Retry configuration
const MAX_RETRIES = 3;
const RETRY_DELAYS = [1000, 3000, 5000]; // Exponential backoff: 1s, 3s, 5s

// Send email with retry logic
async function sendEmailWithRetry(
  client: SMTPClient,
  emailConfig: { from: string; to: string; subject: string; content: string; html: string },
  recipientEmail: string
): Promise<{ success: boolean; error?: string }> {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      await client.send(emailConfig);
      return { success: true };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      console.log(`[Retry] Attempt ${attempt + 1}/${MAX_RETRIES} failed for ${recipientEmail}: ${errorMessage}`);
      
      // Check if it's a permanent failure (don't retry)
      if (errorMessage.includes("550") || errorMessage.includes("553") || errorMessage.includes("invalid")) {
        return { success: false, error: `Permanent failure: ${errorMessage}` };
      }
      
      // If not last attempt, wait and retry
      if (attempt < MAX_RETRIES - 1) {
        await delay(RETRY_DELAYS[attempt]);
      } else {
        return { success: false, error: errorMessage };
      }
    }
  }
  return { success: false, error: "Max retries exceeded" };
}

// Batch size for parallel processing
const BATCH_SIZE = 5;

// Background email processing function with batching and connection reuse
async function processEmailsInBackground(
  supabaseUrl: string,
  supabaseServiceKey: string,
  campaignId: string,
  template: { subject: string; body: string },
  recipients: Recipient[],
  smtpConfig: { host: string; username: string; from_name: string; from_email: string },
  smtpPassword: string,
  isRetry: boolean
) {
  const supabase = createClient(supabaseUrl, supabaseServiceKey);
  console.log(`[Background] Starting email processing for campaign ${campaignId} with ${recipients.length} recipients`);
  
  let sentCount = 0;
  let failedCount = 0;
  let skippedCount = 0;
  const totalRecipients = recipients.length;

  // Get initial counts for retry
  let initialSentCount = 0;
  let initialFailedCount = 0;
  if (isRetry) {
    const { data: campaign } = await supabase
      .from("campaigns")
      .select("sent_count, failed_count")
      .eq("id", campaignId)
      .single();
    if (campaign) {
      initialSentCount = Number(campaign.sent_count) || 0;
      initialFailedCount = Number(campaign.failed_count) || 0;
    }
  }

  // Validate emails upfront and filter invalid ones
  const validRecipients: Recipient[] = [];
  const invalidRecipients: Recipient[] = [];
  
  for (const recipient of recipients) {
    if (isValidEmail(recipient.email)) {
      validRecipients.push(recipient);
    } else {
      invalidRecipients.push(recipient);
      console.log(`[Validation] Invalid email skipped: ${recipient.email}`);
    }
  }
  
  // Mark invalid emails as failed immediately
  for (const recipient of invalidRecipients) {
    await supabase
      .from("email_logs")
      .update({ 
        status: "failed", 
        error_message: "Invalid email format" 
      })
      .eq("campaign_id", campaignId)
      .eq("student_id", recipient.id);
    skippedCount++;
    failedCount++;
  }

  // Update campaign to "sending" status with pending count
  await supabase
    .from("campaigns")
    .update({ 
      status: "sending",
      pending_count: validRecipients.length,
      failed_count: isRetry ? initialFailedCount : failedCount
    })
    .eq("id", campaignId);

  // Create a single SMTP client for connection reuse
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
    console.log(`[Background] SMTP connection established`);

    // Process emails in batches
    for (let batchStart = 0; batchStart < validRecipients.length; batchStart += BATCH_SIZE) {
      const batch = validRecipients.slice(batchStart, batchStart + BATCH_SIZE);
      console.log(`[Background] Processing batch ${Math.floor(batchStart / BATCH_SIZE) + 1} (${batch.length} emails)`);
      
      // Process batch in parallel
      const batchResults = await Promise.all(
        batch.map(async (recipient) => {
          const personalizedSubject = personalizeContent(template.subject, recipient);
          const personalizedBody = personalizeContent(template.body, recipient);
          const normalizedBody = normalizeCRLF(personalizedBody);
          const normalizedSubject = normalizeCRLF(personalizedSubject);
          const htmlBody = normalizedBody.replace(/\r\n/g, "<br>");

          const emailConfig = {
            from: `${smtpConfig.from_name} <${smtpConfig.from_email}>`,
            to: recipient.email,
            subject: normalizedSubject,
            content: normalizedBody,
            html: htmlBody,
          };

          const result = await sendEmailWithRetry(smtpClient!, emailConfig, recipient.email);
          
          return {
            recipient,
            success: result.success,
            error: result.error,
          };
        })
      );

      // Update database for each result
      for (const result of batchResults) {
        if (result.success) {
          await supabase
            .from("email_logs")
            .update({ status: "sent", sent_at: new Date().toISOString(), error_message: null })
            .eq("campaign_id", campaignId)
            .eq("student_id", result.recipient.id);
          sentCount++;
          console.log(`[Background] ✓ Email sent to ${result.recipient.email}`);
        } else {
          await supabase
            .from("email_logs")
            .update({ 
              status: "failed", 
              error_message: result.error || "Unknown error"
            })
            .eq("campaign_id", campaignId)
            .eq("student_id", result.recipient.id);
          failedCount++;
          console.log(`[Background] ✗ Failed: ${result.recipient.email} - ${result.error}`);
        }
      }

      // Update campaign counts after each batch (real-time updates)
      const processedSoFar = sentCount + failedCount - skippedCount;
      const pendingCount = validRecipients.length - processedSoFar;
      const currentSentCount = isRetry ? initialSentCount + sentCount : sentCount;
      const currentFailedCount = isRetry 
        ? Math.max(0, initialFailedCount - sentCount + failedCount) 
        : failedCount;

      await supabase
        .from("campaigns")
        .update({ 
          sent_count: currentSentCount,
          failed_count: currentFailedCount,
          pending_count: Math.max(0, pendingCount)
        })
        .eq("id", campaignId);

      console.log(`[Background] Batch complete. Progress: ${sentCount} sent, ${failedCount} failed, ${pendingCount} pending`);

      // Small delay between batches to avoid overwhelming SMTP server
      if (batchStart + BATCH_SIZE < validRecipients.length) {
        await delay(1000);
      }
    }
  } catch (connectionError) {
    console.error(`[Background] SMTP connection error:`, connectionError);
    // Mark all remaining emails as failed
    for (const recipient of validRecipients) {
      await supabase
        .from("email_logs")
        .update({ 
          status: "failed", 
          error_message: `SMTP connection error: ${connectionError instanceof Error ? connectionError.message : "Unknown"}`
        })
        .eq("campaign_id", campaignId)
        .eq("student_id", recipient.id)
        .eq("status", "pending");
    }
    failedCount += validRecipients.length - sentCount;
  } finally {
    // Close SMTP connection
    if (smtpClient) {
      try {
        await smtpClient.close();
        console.log(`[Background] SMTP connection closed`);
      } catch (closeError) {
        console.error(`[Background] Error closing SMTP:`, closeError);
      }
    }
  }

  // Final status update
  const finalStatus = failedCount === totalRecipients ? "failed" : 
                      sentCount === totalRecipients ? "sent" : "partial";
  
  const finalSentCount = isRetry ? initialSentCount + sentCount : sentCount;
  const finalFailedCount = isRetry 
    ? Math.max(0, initialFailedCount - sentCount + failedCount) 
    : failedCount;

  await supabase
    .from("campaigns")
    .update({ 
      status: finalStatus,
      sent_count: finalSentCount,
      failed_count: finalFailedCount,
      pending_count: 0,
      sent_at: new Date().toISOString()
    })
    .eq("id", campaignId);

  console.log(`[Background] Campaign ${campaignId} completed: ${sentCount} sent, ${failedCount} failed (${skippedCount} invalid emails)`);
}

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const smtpPassword = Deno.env.get("SMTP_PASSWORD");

    if (!smtpPassword) {
      console.error("SMTP_PASSWORD not configured");
      return new Response(
        JSON.stringify({ error: "SMTP password not configured" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const { campaignId, template, recipients, isRetry }: EmailRequest = await req.json();
    console.log(`Received campaign ${campaignId} with ${recipients.length} recipients${isRetry ? ' (RETRY)' : ''}`);

    // Validate recipients count
    if (recipients.length === 0) {
      return new Response(
        JSON.stringify({ error: "No recipients provided" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Get SMTP config from database
    const { data: smtpConfig, error: smtpError } = await supabase
      .from("smtp_config")
      .select("*")
      .limit(1)
      .single();

    if (smtpError || !smtpConfig) {
      console.error("SMTP config not found:", smtpError);
      return new Response(
        JSON.stringify({ error: "SMTP configuration not found. Please configure SMTP settings." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Start background processing using EdgeRuntime.waitUntil
    // @ts-ignore - EdgeRuntime is available in Supabase Edge Functions
    EdgeRuntime.waitUntil(
      processEmailsInBackground(
        supabaseUrl,
        supabaseServiceKey,
        campaignId,
        template,
        recipients,
        smtpConfig,
        smtpPassword,
        isRetry || false
      )
    );

    // Return immediately - processing continues in background
    return new Response(
      JSON.stringify({ 
        success: true, 
        message: "Campaign started. Emails are being sent in the background.",
        totalRecipients: recipients.length
      }),
      { 
        status: 200, 
        headers: { ...corsHeaders, "Content-Type": "application/json" } 
      }
    );
  } catch (error) {
    console.error("Campaign error:", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      { 
        status: 500, 
        headers: { ...corsHeaders, "Content-Type": "application/json" } 
      }
    );
  }
});
