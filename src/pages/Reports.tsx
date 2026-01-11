import { useEffect, useState } from "react";
import { DashboardLayout } from "@/components/layout/DashboardLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Progress } from "@/components/ui/progress";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { BarChart3, RefreshCw, CheckCircle, XCircle, Clock, ChevronDown, ChevronUp, RotateCcw, Loader2, Play } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";

interface EmailLog {
  id: string;
  student_id: string;
  recipient_email: string;
  recipient_name: string;
  status: string;
  error_message: string | null;
  students?: {
    course: string;
  };
}

interface Campaign {
  id: string;
  name: string;
  status: string;
  sent_count: number;
  failed_count: number;
  pending_count: number;
  total_recipients: number;
  created_at: string;
  template_id: string;
  email_templates?: {
    subject: string;
    body: string;
  };
}

export default function Reports() {
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedCampaign, setExpandedCampaign] = useState<string | null>(null);
  const [emailLogs, setEmailLogs] = useState<Record<string, EmailLog[]>>({});
  const [resending, setResending] = useState<string | null>(null);
  const [confirmDialog, setConfirmDialog] = useState<{ open: boolean; campaignId: string; failedEmails: EmailLog[] }>({
    open: false,
    campaignId: "",
    failedEmails: [],
  });

  useEffect(() => {
    fetchCampaigns();

    // Subscribe to real-time updates on campaigns table
    const channel = supabase
      .channel('campaigns-realtime')
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'campaigns'
        },
        (payload) => {
          console.log('Campaign updated:', payload);
          setCampaigns(prev => 
            prev.map(c => 
              c.id === payload.new.id 
                ? { ...c, ...payload.new } as Campaign
                : c
            )
          );
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  const fetchCampaigns = async () => {
    const { data, error } = await supabase
      .from("campaigns")
      .select("*, email_templates(subject, body)")
      .order("created_at", { ascending: false });
    
    if (error) {
      toast.error("Failed to fetch campaigns");
    }
    setCampaigns(data || []);
    setLoading(false);
  };

  const fetchEmailLogs = async (campaignId: string) => {
    if (emailLogs[campaignId]) return;
    
    const { data, error } = await supabase
      .from("email_logs")
      .select("*, students(course)")
      .eq("campaign_id", campaignId)
      .order("status", { ascending: true });
    
    if (error) {
      toast.error("Failed to fetch email logs");
      return;
    }
    
    setEmailLogs(prev => ({ ...prev, [campaignId]: data || [] }));
  };

  const toggleExpand = async (campaignId: string) => {
    if (expandedCampaign === campaignId) {
      setExpandedCampaign(null);
    } else {
      setExpandedCampaign(campaignId);
      await fetchEmailLogs(campaignId);
    }
  };

  const handleResumeCampaign = async (campaign: Campaign) => {
    if (!campaign.email_templates) {
      toast.error("Campaign template not found");
      return;
    }
    
    setResending(campaign.id);
    
    try {
      // Fetch pending email logs with student details
      const { data: pendingLogs, error: logsError } = await supabase
        .from("email_logs")
        .select("student_id, recipient_email, recipient_name, students(course)")
        .eq("campaign_id", campaign.id)
        .eq("status", "pending");
      
      if (logsError || !pendingLogs || pendingLogs.length === 0) {
        toast.info("No pending emails to resume");
        setResending(null);
        return;
      }
      
      const recipients = pendingLogs.map(log => ({
        id: log.student_id,
        name: log.recipient_name,
        email: log.recipient_email,
        course: (log.students as { course: string } | null)?.course || "",
      }));
      
      const { error } = await supabase.functions.invoke("send-campaign-emails", {
        body: {
          campaignId: campaign.id,
          template: {
            subject: campaign.email_templates.subject,
            body: campaign.email_templates.body,
          },
          recipients,
          isRetry: true,
        },
      });
      
      if (error) {
        toast.error("Resume failed: " + error.message);
      } else {
        toast.success(`Resuming ${recipients.length} pending emails in background.`);
        setEmailLogs(prev => {
          const newLogs = { ...prev };
          delete newLogs[campaign.id];
          return newLogs;
        });
      }
    } catch (error) {
      console.error(error);
      toast.error("Failed to resume campaign");
    }
    
    setResending(null);
  };

  const handleResendFailed = async (campaign: Campaign) => {
    const logs = emailLogs[campaign.id];
    if (!logs) {
      await fetchEmailLogs(campaign.id);
    }
    
    const failedEmails = (emailLogs[campaign.id] || []).filter(log => log.status === "failed");
    
    if (failedEmails.length === 0) {
      toast.info("No failed emails to resend");
      return;
    }
    
    setConfirmDialog({
      open: true,
      campaignId: campaign.id,
      failedEmails,
    });
  };

  const confirmResend = async () => {
    const { campaignId, failedEmails } = confirmDialog;
    const campaign = campaigns.find(c => c.id === campaignId);
    
    if (!campaign || !campaign.email_templates) {
      toast.error("Campaign template not found");
      setConfirmDialog({ open: false, campaignId: "", failedEmails: [] });
      return;
    }
    
    setResending(campaignId);
    setConfirmDialog({ open: false, campaignId: "", failedEmails: [] });
    
    try {
      // Reset failed email logs to pending
      await supabase
        .from("email_logs")
        .update({ status: "pending", error_message: null })
        .eq("campaign_id", campaignId)
        .eq("status", "failed");
      
      // Build recipients list from failed emails
      const recipients = failedEmails.map(log => ({
        id: log.student_id,
        name: log.recipient_name,
        email: log.recipient_email,
        course: log.students?.course || "",
      }));
      
      // Call edge function to resend (runs in background)
      const { error } = await supabase.functions.invoke("send-campaign-emails", {
        body: {
          campaignId,
          template: {
            subject: campaign.email_templates.subject,
            body: campaign.email_templates.body,
          },
          recipients,
          isRetry: true,
        },
      });
      
      if (error) {
        toast.error("Resend failed: " + error.message);
      } else {
        toast.success(`Resending ${failedEmails.length} emails in background. Watch the progress below.`);
        // Clear cached logs to force refresh
        setEmailLogs(prev => {
          const newLogs = { ...prev };
          delete newLogs[campaignId];
          return newLogs;
        });
      }
    } catch (error) {
      console.error(error);
      toast.error("Failed to resend emails");
    }
    
    setResending(null);
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case "sent":
        return <CheckCircle className="h-4 w-4 text-green-500" />;
      case "failed":
        return <XCircle className="h-4 w-4 text-destructive" />;
      case "sending":
        return <Loader2 className="h-4 w-4 text-blue-500 animate-spin" />;
      default:
        return <Clock className="h-4 w-4 text-muted-foreground" />;
    }
  };

  const getStatusBadge = (status: string) => {
    const styles: Record<string, string> = {
      sent: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400",
      failed: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400",
      partial: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400",
      sending: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400",
      draft: "bg-gray-100 text-gray-800 dark:bg-gray-900/30 dark:text-gray-400",
    };
    return styles[status] || styles.draft;
  };

  const getProgressPercentage = (campaign: Campaign) => {
    if (campaign.total_recipients === 0) return 0;
    const completed = campaign.sent_count + campaign.failed_count;
    return Math.round((completed / campaign.total_recipients) * 100);
  };

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div className="flex justify-between items-center">
          <div>
            <h1 className="text-2xl font-bold">Reports</h1>
            <p className="text-muted-foreground">View campaign performance and resend failed emails</p>
          </div>
          <Button variant="outline" onClick={fetchCampaigns} disabled={loading}>
            <RefreshCw className={`h-4 w-4 mr-2 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>
        
        <Card className="shadow-card">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <BarChart3 className="h-5 w-5 text-primary" />
              Campaign History
            </CardTitle>
          </CardHeader>
          <CardContent>
            {loading ? (
              <div className="text-center py-8 text-muted-foreground">Loading campaigns...</div>
            ) : campaigns.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">No campaigns found</div>
            ) : (
              <div className="space-y-2">
                {campaigns.map((campaign) => (
                  <Collapsible
                    key={campaign.id}
                    open={expandedCampaign === campaign.id}
                    onOpenChange={() => toggleExpand(campaign.id)}
                  >
                    <div className="border rounded-lg">
                      <CollapsibleTrigger asChild>
                        <div className="flex items-center justify-between p-4 cursor-pointer hover:bg-muted/50">
                          <div className="flex items-center gap-4">
                            {expandedCampaign === campaign.id ? (
                              <ChevronUp className="h-4 w-4" />
                            ) : (
                              <ChevronDown className="h-4 w-4" />
                            )}
                            <div>
                              <p className="font-medium">{campaign.name}</p>
                              <p className="text-sm text-muted-foreground">
                                {new Date(campaign.created_at).toLocaleString()}
                              </p>
                            </div>
                          </div>
                          <div className="flex items-center gap-4">
                            {/* Progress Bar for sending campaigns */}
                            {campaign.status === "sending" && (
                              <div className="w-32 space-y-1">
                                <Progress value={getProgressPercentage(campaign)} className="h-2" />
                                <p className="text-xs text-center text-muted-foreground">
                                  {getProgressPercentage(campaign)}%
                                </p>
                              </div>
                            )}
                            <div className="text-right min-w-[120px]">
                              <p className="text-sm">
                                <span className="text-green-600 font-medium">{campaign.sent_count}</span>
                                {" / "}
                                <span className="text-destructive font-medium">{campaign.failed_count}</span>
                                {campaign.pending_count > 0 && (
                                  <>
                                    {" / "}
                                    <span className="text-blue-600 font-medium">{campaign.pending_count}</span>
                                  </>
                                )}
                                {" / "}
                                <span className="text-muted-foreground">{campaign.total_recipients}</span>
                              </p>
                              <p className="text-xs text-muted-foreground">
                                Sent / Failed{campaign.pending_count > 0 ? " / Pending" : ""} / Total
                              </p>
                            </div>
                            <div className="flex items-center gap-2">
                              {campaign.status === "sending" && (
                                <Loader2 className="h-4 w-4 text-blue-500 animate-spin" />
                              )}
                              <span className={`rounded-full px-3 py-1 text-xs font-medium ${getStatusBadge(campaign.status)}`}>
                                {campaign.status}
                              </span>
                            </div>
                            {/* Resume button for stuck campaigns */}
                            {campaign.pending_count > 0 && campaign.status === "sending" && (
                              <Button
                                variant="default"
                                size="sm"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleResumeCampaign(campaign);
                                }}
                                disabled={resending === campaign.id}
                              >
                                {resending === campaign.id ? (
                                  <RefreshCw className="h-4 w-4 animate-spin" />
                                ) : (
                                  <>
                                    <Play className="h-4 w-4 mr-1" />
                                    Resume
                                  </>
                                )}
                              </Button>
                            )}
                            {campaign.failed_count > 0 && campaign.status !== "sending" && (
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleResendFailed(campaign);
                                }}
                                disabled={resending === campaign.id}
                              >
                                {resending === campaign.id ? (
                                  <RefreshCw className="h-4 w-4 animate-spin" />
                                ) : (
                                  <>
                                    <RotateCcw className="h-4 w-4 mr-1" />
                                    Resend Failed
                                  </>
                                )}
                              </Button>
                            )}
                          </div>
                        </div>
                      </CollapsibleTrigger>
                      <CollapsibleContent>
                        <div className="border-t p-4 bg-muted/30">
                          <h4 className="text-sm font-medium mb-3">Email Details</h4>
                          {emailLogs[campaign.id] ? (
                            <Table>
                              <TableHeader>
                                <TableRow>
                                  <TableHead>Status</TableHead>
                                  <TableHead>Recipient</TableHead>
                                  <TableHead>Email</TableHead>
                                  <TableHead>Course</TableHead>
                                  <TableHead>Error</TableHead>
                                </TableRow>
                              </TableHeader>
                              <TableBody>
                                {emailLogs[campaign.id].map((log) => (
                                  <TableRow key={log.id}>
                                    <TableCell>
                                      <div className="flex items-center gap-2">
                                        {getStatusIcon(log.status)}
                                        <span className="capitalize">{log.status}</span>
                                      </div>
                                    </TableCell>
                                    <TableCell>{log.recipient_name}</TableCell>
                                    <TableCell className="text-muted-foreground">{log.recipient_email}</TableCell>
                                    <TableCell>
                                      <span className="rounded-full bg-accent px-2 py-0.5 text-xs">
                                        {log.students?.course || "-"}
                                      </span>
                                    </TableCell>
                                    <TableCell className="text-destructive text-sm max-w-xs truncate">
                                      {log.error_message || "-"}
                                    </TableCell>
                                  </TableRow>
                                ))}
                              </TableBody>
                            </Table>
                          ) : (
                            <div className="text-center py-4 text-muted-foreground">Loading...</div>
                          )}
                        </div>
                      </CollapsibleContent>
                    </div>
                  </Collapsible>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Confirm Resend Dialog */}
      <Dialog open={confirmDialog.open} onOpenChange={(open) => !open && setConfirmDialog({ open: false, campaignId: "", failedEmails: [] })}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Resend Failed Emails</DialogTitle>
            <DialogDescription>
              Are you sure you want to resend {confirmDialog.failedEmails.length} failed email(s)?
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <div className="max-h-48 overflow-y-auto space-y-2">
              {confirmDialog.failedEmails.map((log) => (
                <div key={log.id} className="flex items-center justify-between text-sm p-2 bg-muted rounded">
                  <span>{log.recipient_name}</span>
                  <span className="text-muted-foreground">{log.recipient_email}</span>
                </div>
              ))}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmDialog({ open: false, campaignId: "", failedEmails: [] })}>
              Cancel
            </Button>
            <Button onClick={confirmResend}>
              <RotateCcw className="h-4 w-4 mr-2" />
              Resend {confirmDialog.failedEmails.length} Email(s)
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </DashboardLayout>
  );
}
