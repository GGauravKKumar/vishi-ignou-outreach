// @ts-nocheck
import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import nodemailer from "https://esm.sh/nodemailer@6.9.10";

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
}

const personalizeContent = (content: string, recipient: Recipient): string => {
  return content
    .replace(/\{\{name\}\}/gi, recipient.name)
    .replace(/\{\{email\}\}/gi, recipient.email)
    .replace(/\{\{course\}\}/gi, recipient.course);
};

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

    const { campaignId, template, recipients }: EmailRequest = await req.json();
    console.log(`Processing campaign ${campaignId} with ${recipients.length} recipients`);

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

    console.log(`SMTP Config: ${smtpConfig.host}:${smtpConfig.port} as ${smtpConfig.username}`);

    // Create nodemailer transporter with proper TLS settings for port 587
    const transporter = nodemailer.createTransport({
      host: smtpConfig.host,
      port: smtpConfig.port,
      secure: smtpConfig.port === 465, // true for 465, false for 587
      auth: {
        user: smtpConfig.username,
        pass: smtpPassword,
      },
      tls: {
        // Do not fail on invalid certs
        rejectUnauthorized: false,
        minVersion: "TLSv1.2"
      }
    });

    // Verify SMTP connection
    try {
      await transporter.verify();
      console.log("SMTP connection verified successfully");
    } catch (verifyError) {
      console.error("SMTP verification failed:", verifyError);
      return new Response(
        JSON.stringify({ error: `SMTP connection failed: ${verifyError instanceof Error ? verifyError.message : "Unknown error"}` }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    let sentCount = 0;
    let failedCount = 0;

    // Send emails to each recipient
    for (const recipient of recipients) {
      const personalizedSubject = personalizeContent(template.subject, recipient);
      const personalizedBody = personalizeContent(template.body, recipient);

      try {
        console.log(`Sending email to ${recipient.email}...`);
        
        await transporter.sendMail({
          from: `"${smtpConfig.from_name}" <${smtpConfig.from_email}>`,
          to: recipient.email,
          subject: personalizedSubject,
          text: personalizedBody,
          html: personalizedBody.replace(/\n/g, "<br>"),
        });

        // Update email log as sent
        await supabase
          .from("email_logs")
          .update({ status: "sent", sent_at: new Date().toISOString() })
          .eq("campaign_id", campaignId)
          .eq("student_id", recipient.id);

        sentCount++;
        console.log(`✓ Email sent to ${recipient.email}`);
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
      }
    }

    // Close transporter
    transporter.close();

    // Update campaign status
    const campaignStatus = failedCount === recipients.length ? "failed" : 
                          sentCount === recipients.length ? "sent" : "partial";
    
    await supabase
      .from("campaigns")
      .update({ 
        status: campaignStatus, 
        sent_count: sentCount, 
        failed_count: failedCount,
        sent_at: new Date().toISOString()
      })
      .eq("id", campaignId);

    console.log(`Campaign ${campaignId} completed: ${sentCount} sent, ${failedCount} failed`);

    return new Response(
      JSON.stringify({ 
        success: true, 
        sent: sentCount, 
        failed: failedCount 
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
