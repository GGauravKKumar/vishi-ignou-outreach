import { useEffect, useState } from "react";
import { DashboardLayout } from "@/components/layout/DashboardLayout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { useAuth } from "@/hooks/useAuth";
import { Send, Users, FileText, Eye, Mail, CheckCircle, AlertCircle } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface Student {
  id: string;
  name: string;
  email: string;
  course: string;
}

interface EmailTemplate {
  id: string;
  name: string;
  subject: string;
  body: string;
  service_type: string;
}

export default function Campaigns() {
  const { user } = useAuth();
  const [students, setStudents] = useState<Student[]>([]);
  const [templates, setTemplates] = useState<EmailTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);

  const [campaignName, setCampaignName] = useState("");
  const [selectedTemplate, setSelectedTemplate] = useState<string>("");
  const [selectedStudents, setSelectedStudents] = useState<string[]>([]);
  const [courseFilter, setCourseFilter] = useState<string>("all");

  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewStudent, setPreviewStudent] = useState<Student | null>(null);

  useEffect(() => {
    fetchData();
  }, []);

  const fetchAllStudents = async (): Promise<Student[]> => {
    const allStudents: Student[] = [];
    const pageSize = 1000;
    let page = 0;
    let hasMore = true;

    while (hasMore) {
      const { data, error } = await supabase
        .from("students")
        .select("*")
        .order("name")
        .range(page * pageSize, (page + 1) * pageSize - 1);

      if (error) {
        toast.error("Failed to fetch students");
        break;
      }

      if (data && data.length > 0) {
        allStudents.push(...data);
        hasMore = data.length === pageSize;
        page++;
      } else {
        hasMore = false;
      }
    }

    return allStudents;
  };

  const fetchData = async () => {
    const [allStudents, templatesRes] = await Promise.all([
      fetchAllStudents(),
      supabase.from("email_templates").select("*").order("name"),
    ]);

    if (templatesRes.error) toast.error("Failed to fetch templates");

    setStudents(allStudents);
    setTemplates(templatesRes.data || []);
    setLoading(false);
  };

  const uniqueCourses = [...new Set(students.map((s) => s.course))];

  const filteredStudents =
    courseFilter === "all"
      ? students
      : students.filter((s) => s.course === courseFilter);

  const toggleStudent = (id: string) => {
    setSelectedStudents((prev) =>
      prev.includes(id) ? prev.filter((sid) => sid !== id) : [...prev, id]
    );
  };

  const selectAll = () => {
    if (selectedStudents.length === filteredStudents.length) {
      setSelectedStudents([]);
    } else {
      setSelectedStudents(filteredStudents.map((s) => s.id));
    }
  };

  const getTemplate = () => templates.find((t) => t.id === selectedTemplate);

  const personalizeContent = (content: string, student: Student) => {
    return content
      .replace(/\{\{name\}\}/gi, student.name)
      .replace(/\{\{email\}\}/gi, student.email)
      .replace(/\{\{course\}\}/gi, student.course);
  };

  const openPreview = (student: Student) => {
    setPreviewStudent(student);
    setPreviewOpen(true);
  };

  const handleSendCampaign = async () => {
    if (!campaignName.trim()) {
      toast.error("Please enter a campaign name");
      return;
    }
    if (!selectedTemplate) {
      toast.error("Please select a template");
      return;
    }
    if (selectedStudents.length === 0) {
      toast.error("Please select at least one student");
      return;
    }

    setSending(true);

    try {
      // Create campaign
      const { data: campaign, error: campaignError } = await supabase
        .from("campaigns")
        .insert([
          {
            name: campaignName,
            template_id: selectedTemplate,
            status: "sending",
            total_recipients: selectedStudents.length,
            created_by: user?.id,
          },
        ])
        .select()
        .single();

      if (campaignError) throw campaignError;

      // Create email logs for each recipient
      const emailLogs = selectedStudents.map((studentId) => {
        const student = students.find((s) => s.id === studentId)!;
        return {
          campaign_id: campaign.id,
          student_id: studentId,
          recipient_email: student.email,
          recipient_name: student.name,
          status: "pending",
        };
      });

      const { error: logsError } = await supabase.from("email_logs").insert(emailLogs);
      if (logsError) throw logsError;

      // Call edge function to send emails
      const template = getTemplate()!;
      const { data, error } = await supabase.functions.invoke("send-campaign-emails", {
        body: {
          campaignId: campaign.id,
          template: {
            subject: template.subject,
            body: template.body,
          },
          recipients: selectedStudents.map((id) => {
            const student = students.find((s) => s.id === id)!;
            return {
              id: student.id,
              name: student.name,
              email: student.email,
              course: student.course,
            };
          }),
        },
      });

      if (error) {
        toast.error("Campaign created but email sending failed. Check settings.");
      } else {
        toast.success(`Campaign sent to ${selectedStudents.length} students!`);
      }

      // Reset form
      setCampaignName("");
      setSelectedTemplate("");
      setSelectedStudents([]);
    } catch (error) {
      console.error(error);
      toast.error("Failed to create campaign");
    }

    setSending(false);
  };

  const template = getTemplate();

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold">Send Campaign</h1>
          <p className="text-muted-foreground">
            Create and send personalized email campaigns to students
          </p>
        </div>

        <div className="grid gap-6 lg:grid-cols-3">
          {/* Campaign Setup */}
          <div className="lg:col-span-2 space-y-6">
            <Card className="shadow-card">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Send className="h-5 w-5 text-primary" />
                  Campaign Setup
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="campaign-name">Campaign Name</Label>
                  <Input
                    id="campaign-name"
                    placeholder="e.g., December Assignment Promo"
                    value={campaignName}
                    onChange={(e) => setCampaignName(e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label>Email Template</Label>
                  <Select value={selectedTemplate} onValueChange={setSelectedTemplate}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select a template" />
                    </SelectTrigger>
                    <SelectContent>
                      {templates.map((t) => (
                        <SelectItem key={t.id} value={t.id}>
                          {t.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {templates.length === 0 && (
                    <p className="text-sm text-muted-foreground">
                      No templates found. Create one first.
                    </p>
                  )}
                </div>
              </CardContent>
            </Card>

            {/* Recipients Selection */}
            <Card className="shadow-card">
              <CardHeader>
                <div className="flex items-center justify-between">
                  <CardTitle className="flex items-center gap-2">
                    <Users className="h-5 w-5 text-primary" />
                    Select Recipients
                  </CardTitle>
                  <Select value={courseFilter} onValueChange={setCourseFilter}>
                    <SelectTrigger className="w-40">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All Courses</SelectItem>
                      {uniqueCourses.map((course) => (
                        <SelectItem key={course} value={course}>
                          {course}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <CardDescription>
                  {selectedStudents.length} of {filteredStudents.length} selected
                </CardDescription>
              </CardHeader>
              <CardContent>
                {loading ? (
                  <p className="text-center py-8 text-muted-foreground">Loading students...</p>
                ) : filteredStudents.length === 0 ? (
                  <div className="text-center py-8">
                    <Users className="mx-auto h-12 w-12 text-muted-foreground/50" />
                    <p className="mt-2 text-muted-foreground">No students found</p>
                  </div>
                ) : (
                  <div className="space-y-2">
                    <div className="flex items-center gap-2 pb-2 border-b">
                      <Checkbox
                        checked={selectedStudents.length === filteredStudents.length}
                        onCheckedChange={selectAll}
                      />
                      <span className="text-sm font-medium">Select All</span>
                    </div>
                    <div className="max-h-64 overflow-y-auto space-y-2">
                      {filteredStudents.map((student) => (
                        <div
                          key={student.id}
                          className="flex items-center justify-between rounded-lg border p-3 hover:bg-muted/50"
                        >
                          <div className="flex items-center gap-3">
                            <Checkbox
                              checked={selectedStudents.includes(student.id)}
                              onCheckedChange={() => toggleStudent(student.id)}
                            />
                            <div>
                              <p className="font-medium">{student.name}</p>
                              <p className="text-sm text-muted-foreground">{student.email}</p>
                            </div>
                          </div>
                          <div className="flex items-center gap-2">
                            <span className="rounded-full bg-accent px-2 py-0.5 text-xs text-accent-foreground">
                              {student.course}
                            </span>
                            {selectedTemplate && (
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => openPreview(student)}
                              >
                                <Eye className="h-4 w-4" />
                              </Button>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>

          {/* Summary */}
          <div className="space-y-6">
            <Card className="shadow-card">
              <CardHeader>
                <CardTitle>Campaign Summary</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Recipients</span>
                  <span className="font-bold">{selectedStudents.length}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Template</span>
                  <span className="font-medium text-right truncate max-w-32">
                    {template?.name || "Not selected"}
                  </span>
                </div>
                <div className="border-t pt-4">
                  <Button
                    className="w-full gradient-primary"
                    disabled={sending || !campaignName || !selectedTemplate || selectedStudents.length === 0}
                    onClick={handleSendCampaign}
                  >
                    {sending ? (
                      "Sending..."
                    ) : (
                      <>
                        <Send className="mr-2 h-4 w-4" />
                        Send Campaign
                      </>
                    )}
                  </Button>
                </div>
              </CardContent>
            </Card>

            {template && (
              <Card className="shadow-card">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-base">
                    <FileText className="h-4 w-4" />
                    Template Preview
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-sm font-medium">{template.subject}</p>
                  <p className="mt-2 text-sm text-muted-foreground line-clamp-6 whitespace-pre-line">
                    {template.body.substring(0, 200)}...
                  </p>
                </CardContent>
              </Card>
            )}
          </div>
        </div>
      </div>

      {/* Preview Dialog */}
      <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
        <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Mail className="h-5 w-5" />
              Email Preview for {previewStudent?.name}
            </DialogTitle>
            <DialogDescription>
              This is how the email will look for this recipient
            </DialogDescription>
          </DialogHeader>
          {template && previewStudent && (
            <div className="space-y-4 py-4">
              <div className="rounded-lg border p-4">
                <p className="text-sm text-muted-foreground">Subject:</p>
                <p className="font-medium">
                  {personalizeContent(template.subject, previewStudent)}
                </p>
              </div>
              <div className="rounded-lg border p-4">
                <p className="text-sm text-muted-foreground mb-2">Body:</p>
                <div className="whitespace-pre-line text-sm">
                  {personalizeContent(template.body, previewStudent)}
                </div>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setPreviewOpen(false)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </DashboardLayout>
  );
}
