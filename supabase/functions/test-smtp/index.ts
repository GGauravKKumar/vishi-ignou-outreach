import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { SMTPClient } from "https://deno.land/x/denomailer@1.6.0/mod.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const startTime = Date.now();
  
  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const smtpPassword = Deno.env.get("SMTP_PASSWORD");

    if (!smtpPassword) {
      console.error("SMTP_PASSWORD not configured");
      return new Response(
        JSON.stringify({ 
          success: false, 
          error: "SMTP password not configured in secrets",
          step: "password_check"
        }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Get SMTP config from database
    const { data: smtpConfig, error: smtpError } = await supabase
      .from("smtp_config")
      .select("*")
      .limit(1)
      .single();

    if (smtpError || !smtpConfig) {
      console.error("SMTP config not found:", smtpError);
      return new Response(
        JSON.stringify({ 
          success: false, 
          error: "SMTP configuration not found. Please save your settings first.",
          step: "config_check"
        }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log(`Testing SMTP connection to ${smtpConfig.host}:465`);

    // Try to establish SMTP connection
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

    // Try to send a test email to the from_email address
    const body = await req.json().catch(() => ({}));
    const sendTestEmail = body.sendTestEmail === true;
    
    if (sendTestEmail) {
      console.log("Sending test email...");
      await client.send({
        from: `${smtpConfig.from_name} <${smtpConfig.from_email}>`,
        to: smtpConfig.from_email,
        subject: "SMTP Test - Connection Successful",
        content: "This is a test email to verify your SMTP configuration is working correctly.\r\n\r\nIf you received this email, your email sending is properly configured!",
        html: "<h2>SMTP Test Successful!</h2><p>This is a test email to verify your SMTP configuration is working correctly.</p><p>If you received this email, your email sending is properly configured!</p>",
      });
      console.log("Test email sent successfully");
    }

    // Close connection
    await client.close();
    
    const duration = Date.now() - startTime;
    console.log(`SMTP test completed in ${duration}ms`);

    return new Response(
      JSON.stringify({ 
        success: true, 
        message: sendTestEmail 
          ? `Connection successful! Test email sent to ${smtpConfig.from_email}`
          : "SMTP connection established successfully",
        host: smtpConfig.host,
        port: 465,
        username: smtpConfig.username,
        duration_ms: duration
      }),
      { 
        status: 200, 
        headers: { ...corsHeaders, "Content-Type": "application/json" } 
      }
    );
  } catch (error) {
    const duration = Date.now() - startTime;
    console.error("SMTP test error:", error);
    
    let errorMessage = error instanceof Error ? error.message : "Unknown error";
    let suggestion = "";
    
    // Provide helpful suggestions based on error
    if (errorMessage.includes("535") || errorMessage.includes("authentication")) {
      suggestion = "Check your username and password. Make sure 2FA is disabled or use an app password.";
    } else if (errorMessage.includes("connect") || errorMessage.includes("timeout")) {
      suggestion = "Unable to connect to SMTP server. Check the host address and ensure port 465 is not blocked.";
    } else if (errorMessage.includes("certificate")) {
      suggestion = "SSL/TLS certificate issue. The server may have an invalid certificate.";
    }
    
    return new Response(
      JSON.stringify({ 
        success: false, 
        error: errorMessage,
        suggestion,
        duration_ms: duration
      }),
      { 
        status: 200, // Return 200 so frontend can parse the error
        headers: { ...corsHeaders, "Content-Type": "application/json" } 
      }
    );
  }
});
