import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// 10 minutes threshold for stuck campaigns
const STUCK_THRESHOLD_MS = 10 * 60 * 1000;

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    console.log("[Auto-Resume] Checking for stuck campaigns...");

    // Find campaigns stuck in "sending" status
    const { data: sendingCampaigns, error: campaignsError } = await supabase
      .from("campaigns")
      .select("id, name, created_at, pending_count, template_id")
      .eq("status", "sending");

    if (campaignsError) {
      console.error("[Auto-Resume] Error fetching campaigns:", campaignsError);
      return new Response(
        JSON.stringify({ error: campaignsError.message }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (!sendingCampaigns || sendingCampaigns.length === 0) {
      console.log("[Auto-Resume] No campaigns in sending status");
      return new Response(
        JSON.stringify({ message: "No stuck campaigns found" }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const now = Date.now();
    const stuckCampaigns = [];

    for (const campaign of sendingCampaigns) {
      // Check if any email was sent recently (within 10 mins)
      const { data: recentLogs } = await supabase
        .from("email_logs")
        .select("sent_at, created_at")
        .eq("campaign_id", campaign.id)
        .or("status.eq.sent,status.eq.failed")
        .order("sent_at", { ascending: false, nullsFirst: false })
        .limit(1);

      let lastActivity: Date;
      
      if (recentLogs && recentLogs.length > 0 && recentLogs[0].sent_at) {
        lastActivity = new Date(recentLogs[0].sent_at);
      } else {
        // No emails sent yet, use campaign creation time
        lastActivity = new Date(campaign.created_at);
      }

      const timeSinceActivity = now - lastActivity.getTime();
      
      if (timeSinceActivity > STUCK_THRESHOLD_MS && campaign.pending_count > 0) {
        console.log(`[Auto-Resume] Campaign "${campaign.name}" is stuck (${Math.round(timeSinceActivity / 60000)} mins since last activity, ${campaign.pending_count} pending)`);
        stuckCampaigns.push(campaign);
      }
    }

    if (stuckCampaigns.length === 0) {
      console.log("[Auto-Resume] No stuck campaigns detected");
      return new Response(
        JSON.stringify({ message: "No stuck campaigns found" }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Resume each stuck campaign
    const resumeResults = [];

    for (const campaign of stuckCampaigns) {
      try {
        // Get pending email logs
        const { data: pendingLogs } = await supabase
          .from("email_logs")
          .select("student_id")
          .eq("campaign_id", campaign.id)
          .eq("status", "pending");

        if (!pendingLogs || pendingLogs.length === 0) {
          console.log(`[Auto-Resume] No pending emails for campaign "${campaign.name}", marking as complete`);
          
          // Get final counts
          const { data: finalCampaign } = await supabase
            .from("campaigns")
            .select("sent_count, failed_count, total_recipients")
            .eq("id", campaign.id)
            .single();
          
          if (finalCampaign) {
            const finalStatus = finalCampaign.failed_count === finalCampaign.total_recipients ? "failed" : 
                               finalCampaign.sent_count === finalCampaign.total_recipients ? "sent" : "partial";
            await supabase
              .from("campaigns")
              .update({ status: finalStatus, sent_at: new Date().toISOString(), pending_count: 0 })
              .eq("id", campaign.id);
          }
          
          resumeResults.push({ campaignId: campaign.id, name: campaign.name, status: "completed" });
          continue;
        }

        // Get student details for pending emails
        const studentIds = pendingLogs.map(l => l.student_id).filter(Boolean);
        const { data: students } = await supabase
          .from("students")
          .select("id, name, email, course")
          .in("id", studentIds);

        if (!students || students.length === 0) {
          console.log(`[Auto-Resume] No students found for pending emails in "${campaign.name}"`);
          resumeResults.push({ campaignId: campaign.id, name: campaign.name, status: "no_students" });
          continue;
        }

        // Get template
        const { data: template } = await supabase
          .from("email_templates")
          .select("subject, body")
          .eq("id", campaign.template_id)
          .single();

        if (!template) {
          console.log(`[Auto-Resume] Template not found for campaign "${campaign.name}"`);
          resumeResults.push({ campaignId: campaign.id, name: campaign.name, status: "no_template" });
          continue;
        }

        console.log(`[Auto-Resume] Resuming campaign "${campaign.name}" with ${students.length} pending recipients`);

        // Invoke send-campaign-emails
        const { error: invokeError } = await supabase.functions.invoke('send-campaign-emails', {
          body: {
            campaignId: campaign.id,
            template: {
              subject: template.subject,
              body: template.body
            },
            recipients: students.map(s => ({
              id: s.id,
              name: s.name,
              email: s.email,
              course: s.course
            })),
            isRetry: true
          }
        });

        if (invokeError) {
          console.error(`[Auto-Resume] Failed to invoke for "${campaign.name}":`, invokeError);
          resumeResults.push({ campaignId: campaign.id, name: campaign.name, status: "invoke_failed", error: invokeError.message });
        } else {
          console.log(`[Auto-Resume] Successfully resumed campaign "${campaign.name}"`);
          resumeResults.push({ campaignId: campaign.id, name: campaign.name, status: "resumed", pendingCount: students.length });
        }
      } catch (err) {
        console.error(`[Auto-Resume] Error processing campaign "${campaign.name}":`, err);
        resumeResults.push({ campaignId: campaign.id, name: campaign.name, status: "error", error: err instanceof Error ? err.message : "Unknown" });
      }
    }

    console.log("[Auto-Resume] Complete:", resumeResults);

    return new Response(
      JSON.stringify({ 
        message: `Processed ${stuckCampaigns.length} stuck campaigns`,
        results: resumeResults 
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("[Auto-Resume] Error:", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
