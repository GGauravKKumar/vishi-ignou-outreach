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

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Background email processing function
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
  console.log(`[Background] Starting email processing for campaign ${campaignId}`);
  
  let sentCount = 0;
  let failedCount = 0;
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

  // Update campaign to "sending" status with pending count
  await supabase
    .from("campaigns")
    .update({ 
      status: "sending",
      pending_count: totalRecipients
    })
    .eq("id", campaignId);

  // Send emails one at a time
  for (let i = 0; i < recipients.length; i++) {
    const recipient = recipients[i];
    const personalizedSubject = personalizeContent(template.subject, recipient);
    const personalizedBody = personalizeContent(template.body, recipient);

    try {
      console.log(`[Background] Sending email ${i + 1}/${totalRecipients} to ${recipient.email}...`);
      
      const client = new SMTPClient({
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

      const normalizedBody = normalizeCRLF(personalizedBody);
      const normalizedSubject = normalizeCRLF(personalizedSubject);
      const htmlBody = normalizedBody.replace(/\r\n/g, "<br>");

      await client.send({
        from: `${smtpConfig.from_name} <${smtpConfig.from_email}>`,
        to: recipient.email,
        subject: normalizedSubject,
        content: normalizedBody,
        html: htmlBody,
      });

      await client.close();

      // Update email log as sent
      await supabase
        .from("email_logs")
        .update({ status: "sent", sent_at: new Date().toISOString(), error_message: null })
        .eq("campaign_id", campaignId)
        .eq("student_id", recipient.id);

      sentCount++;
      console.log(`[Background] ✓ Email sent to ${recipient.email} (${sentCount}/${totalRecipients})`);

    } catch (emailError) {
      console.error(`[Background] ✗ Failed to send to ${recipient.email}:`, emailError);
      
      await supabase
        .from("email_logs")
        .update({ 
          status: "failed", 
          error_message: emailError instanceof Error ? emailError.message : "Unknown error" 
        })
        .eq("campaign_id", campaignId)
        .eq("student_id", recipient.id);

      failedCount++;
    }

    // Update campaign counts after each email (real-time updates)
    const pendingCount = totalRecipients - sentCount - failedCount;
    const currentSentCount = isRetry ? initialSentCount + sentCount : sentCount;
    const currentFailedCount = isRetry 
      ? Math.max(0, initialFailedCount - sentCount + failedCount) 
      : failedCount;

    await supabase
      .from("campaigns")
      .update({ 
        sent_count: currentSentCount,
        failed_count: currentFailedCount,
        pending_count: pendingCount
      })
      .eq("id", campaignId);

    // Small delay between emails to avoid rate limiting
    if (i < recipients.length - 1) {
      await delay(500);
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

  console.log(`[Background] Campaign ${campaignId} completed: ${sentCount} sent, ${failedCount} failed`);
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
