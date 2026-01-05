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
    console.log(`Processing campaign ${campaignId} with ${recipients.length} recipients${isRetry ? ' (RETRY)' : ''}`);

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

    // Use port 465 with SSL for better compatibility
    const usePort = 465;
    const useTls = true;
    
    console.log(`SMTP Config: ${smtpConfig.host}:${usePort} as ${smtpConfig.username} (TLS: ${useTls})`);

    let sentCount = 0;
    let failedCount = 0;
    const failedRecipients: Recipient[] = [];

    // Send emails one at a time with a new connection for each
    for (const recipient of recipients) {
      const personalizedSubject = personalizeContent(template.subject, recipient);
      const personalizedBody = personalizeContent(template.body, recipient);

      try {
        console.log(`Sending email to ${recipient.email}...`);
        
        // Create a new client for each email to avoid connection issues
        const client = new SMTPClient({
          connection: {
            hostname: smtpConfig.host,
            port: usePort,
            tls: useTls,
            auth: {
              username: smtpConfig.username,
              password: smtpPassword,
            },
          },
        });

        // Normalize line endings to CRLF for RFC 822 compliance
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
        console.log(`✓ Email sent to ${recipient.email}`);
        
        // Small delay between emails to avoid rate limiting
        if (recipients.indexOf(recipient) < recipients.length - 1) {
          await delay(500);
        }
      } catch (emailError) {
        console.error(`✗ Failed to send to ${recipient.email}:`, emailError);
        
        // Update email log as failed
        await supabase
          .from("email_logs")
          .update({ 
            status: "failed", 
            error_message: emailError instanceof Error ? emailError.message : "Unknown error" 
          })
          .eq("campaign_id", campaignId)
          .eq("student_id", recipient.id);

        failedCount++;
        failedRecipients.push(recipient);
      }
    }

    // Update campaign status
    const campaignStatus = failedCount === recipients.length ? "failed" : 
                          sentCount === recipients.length ? "sent" : "partial";
    
    // For retry, we need to add to existing counts
    if (isRetry) {
      const { data: campaign } = await supabase
        .from("campaigns")
        .select("sent_count, failed_count")
        .eq("id", campaignId)
        .single();
      
      if (campaign) {
        await supabase
          .from("campaigns")
          .update({ 
            status: campaignStatus,
            sent_count: campaign.sent_count + sentCount,
            failed_count: Math.max(0, campaign.failed_count - sentCount + failedCount),
            sent_at: new Date().toISOString()
          })
          .eq("id", campaignId);
      }
    } else {
      await supabase
        .from("campaigns")
        .update({ 
          status: campaignStatus, 
          sent_count: sentCount, 
          failed_count: failedCount,
          sent_at: new Date().toISOString()
        })
        .eq("id", campaignId);
    }

    console.log(`Campaign ${campaignId} completed: ${sentCount} sent, ${failedCount} failed`);

    return new Response(
      JSON.stringify({ 
        success: true, 
        sent: sentCount, 
        failed: failedCount,
        failedRecipients: failedRecipients.map(r => ({ id: r.id, email: r.email, name: r.name }))
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