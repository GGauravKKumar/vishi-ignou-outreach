import { useEffect, useState, useCallback } from "react";
import { DashboardLayout } from "@/components/layout/DashboardLayout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { useAuth } from "@/hooks/useAuth";
import { Send, Users, FileText, Eye, Mail, Search, X, Loader2 } from "lucide-react";
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
  const [templates, setTemplates] = useState<EmailTemplate[]>([]);
  const [courses, setCourses] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);

  const [campaignName, setCampaignName] = useState("");
  const [selectedTemplate, setSelectedTemplate] = useState<string>("");
  const [selectedStudents, setSelectedStudents] = useState<Student[]>([]);
  const [courseFilter, setCourseFilter] = useState<string>("");

  // Search state
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<Student[]>([]);
  const [searching, setSearching] = useState(false);

  // Select all by course state
  const [selectingAll, setSelectingAll] = useState(false);
  const [courseStudentCount, setCourseStudentCount] = useState<number>(0);

  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewStudent, setPreviewStudent] = useState<Student | null>(null);

  useEffect(() => {
    fetchInitialData();
  }, []);

  // Fetch course count when course filter changes
  useEffect(() => {
    if (courseFilter && courseFilter !== "all") {
      fetchCourseStudentCount(courseFilter);
    } else {
      setCourseStudentCount(0);
    }
  }, [courseFilter]);

  const fetchInitialData = async () => {
    try {
      // Fetch templates
      const templatesRes = await supabase.from("email_templates").select("*").order("name");
      if (templatesRes.error) toast.error("Failed to fetch templates");
      setTemplates(templatesRes.data || []);

      // Fetch ALL courses by paginating through all students
      const allCourses: string[] = [];
      const pageSize = 1000;
      let page = 0;
      let hasMore = true;

      while (hasMore) {
        const { data, error } = await supabase
          .from("students")
          .select("course")
          .range(page * pageSize, (page + 1) * pageSize - 1);

        if (error) {
          toast.error("Failed to fetch courses");
          break;
        }

        if (data && data.length > 0) {
          allCourses.push(...data.map((s) => s.course));
          hasMore = data.length === pageSize;
          page++;
        } else {
          hasMore = false;
        }
      }

      // Extract unique courses
      const uniqueCourses = [...new Set(allCourses)];
      setCourses(uniqueCourses.sort());
    } catch (error) {
      console.error("Error fetching initial data:", error);
      toast.error("Failed to load data");
    }
    setLoading(false);
  };

  const fetchCourseStudentCount = async (course: string) => {
    const { count, error } = await supabase
      .from("students")
      .select("*", { count: "exact", head: true })
      .eq("course", course);

    if (!error && count !== null) {
      setCourseStudentCount(count);
    }
  };

  // Search students by name or email
  const searchStudents = useCallback(async (query: string) => {
    if (!query.trim() || query.length < 2) {
      setSearchResults([]);
      return;
    }

    setSearching(true);
    try {
      let queryBuilder = supabase
        .from("students")
        .select("id, name, email, course")
        .or(`name.ilike.%${query}%,email.ilike.%${query}%`)
        .limit(20);

      if (courseFilter && courseFilter !== "all") {
        queryBuilder = queryBuilder.eq("course", courseFilter);
      }

      const { data, error } = await queryBuilder;

      if (error) {
        toast.error("Search failed");
        return;
      }

      // Filter out already selected students
      const selectedIds = new Set(selectedStudents.map((s) => s.id));
      setSearchResults((data || []).filter((s) => !selectedIds.has(s.id)));
    } catch (error) {
      console.error("Search error:", error);
    }
    setSearching(false);
  }, [courseFilter, selectedStudents]);

  // Debounced search
  useEffect(() => {
    const timer = setTimeout(() => {
      searchStudents(searchQuery);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchQuery, searchStudents]);

  // Select all students from a course
  const selectAllFromCourse = async () => {
    if (!courseFilter || courseFilter === "all") {
      toast.error("Please select a course first");
      return;
    }

    setSelectingAll(true);
    try {
      const allStudents: Student[] = [];
      const pageSize = 1000;
      let page = 0;
      let hasMore = true;

      while (hasMore) {
        const { data, error } = await supabase
          .from("students")
          .select("id, name, email, course")
          .eq("course", courseFilter)
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

      // Merge with existing selections (avoid duplicates)
      const existingIds = new Set(selectedStudents.map((s) => s.id));
      const newStudents = allStudents.filter((s) => !existingIds.has(s.id));
      setSelectedStudents([...selectedStudents, ...newStudents]);
      
      toast.success(`Added ${newStudents.length} students from ${courseFilter}`);
    } catch (error) {
      console.error("Error selecting all:", error);
      toast.error("Failed to select students");
    }
    setSelectingAll(false);
  };

  const addStudent = (student: Student) => {
    if (!selectedStudents.find((s) => s.id === student.id)) {
      setSelectedStudents([...selectedStudents, student]);
    }
    setSearchQuery("");
    setSearchResults([]);
  };

  const removeStudent = (studentId: string) => {
    setSelectedStudents(selectedStudents.filter((s) => s.id !== studentId));
  };

  const clearAllStudents = () => {
    setSelectedStudents([]);
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

    // Validate template has subject
    const template = getTemplate();
    if (!template?.subject?.trim()) {
      toast.error("Template must have a subject line");
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
      const emailLogs = selectedStudents.map((student) => ({
        campaign_id: campaign.id,
        student_id: student.id,
        recipient_email: student.email,
        recipient_name: student.name,
        status: "pending",
      }));

      const { error: logsError } = await supabase.from("email_logs").insert(emailLogs);
      if (logsError) throw logsError;

      // Call edge function to send emails
      const { error } = await supabase.functions.invoke("send-campaign-emails", {
        body: {
          campaignId: campaign.id,
          template: {
            subject: template.subject,
            body: template.body,
          },
          recipients: selectedStudents.map((student) => ({
            id: student.id,
            name: student.name,
            email: student.email,
            course: student.course,
          })),
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
                <CardTitle className="flex items-center gap-2">
                  <Users className="h-5 w-5 text-primary" />
                  Select Recipients
                </CardTitle>
                <CardDescription>
                  Search by name/email or select all from a course
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {/* Course Filter and Select All */}
                <div className="flex flex-col sm:flex-row gap-3">
                  <div className="flex-1">
                    <Select value={courseFilter} onValueChange={setCourseFilter}>
                      <SelectTrigger>
                        <SelectValue placeholder="Filter by course" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">All Courses</SelectItem>
                        {courses.map((course) => (
                          <SelectItem key={course} value={course}>
                            {course}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <Button
                    variant="outline"
                    onClick={selectAllFromCourse}
                    disabled={!courseFilter || courseFilter === "all" || selectingAll}
                  >
                    {selectingAll ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        Loading...
                      </>
                    ) : (
                      <>
                        <Users className="mr-2 h-4 w-4" />
                        Select All {courseFilter && courseFilter !== "all" && courseStudentCount > 0 && `(${courseStudentCount})`}
                      </>
                    )}
                  </Button>
                </div>

                {/* Search Input */}
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    placeholder="Search by name or email..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="pl-10"
                  />
                  {searching && (
                    <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 animate-spin text-muted-foreground" />
                  )}
                </div>

                {/* Search Results */}
                {searchResults.length > 0 && (
                  <div className="border rounded-lg divide-y max-h-48 overflow-y-auto">
                    {searchResults.map((student) => (
                      <div
                        key={student.id}
                        className="flex items-center justify-between p-3 hover:bg-muted/50 cursor-pointer"
                        onClick={() => addStudent(student)}
                      >
                        <div>
                          <p className="font-medium">{student.name}</p>
                          <p className="text-sm text-muted-foreground">{student.email}</p>
                        </div>
                        <span className="rounded-full bg-accent px-2 py-0.5 text-xs text-accent-foreground">
                          {student.course}
                        </span>
                      </div>
                    ))}
                  </div>
                )}

                {/* Selected Students */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label>Selected Recipients ({selectedStudents.length})</Label>
                    {selectedStudents.length > 0 && (
                      <Button variant="ghost" size="sm" onClick={clearAllStudents}>
                        Clear All
                      </Button>
                    )}
                  </div>
                  
                  {selectedStudents.length === 0 ? (
                    <div className="text-center py-8 border rounded-lg border-dashed">
                      <Users className="mx-auto h-12 w-12 text-muted-foreground/50" />
                      <p className="mt-2 text-muted-foreground">
                        No students selected. Search or select all from a course.
                      </p>
                    </div>
                  ) : (
                    <div className="max-h-64 overflow-y-auto space-y-2 border rounded-lg p-2">
                      {selectedStudents.map((student) => (
                        <div
                          key={student.id}
                          className="flex items-center justify-between rounded-lg border p-3 hover:bg-muted/50"
                        >
                          <div className="flex items-center gap-3 flex-1 min-w-0">
                            <div className="min-w-0 flex-1">
                              <p className="font-medium truncate">{student.name}</p>
                              <p className="text-sm text-muted-foreground truncate">{student.email}</p>
                            </div>
                          </div>
                          <div className="flex items-center gap-2 flex-shrink-0">
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
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => removeStudent(student.id)}
                            >
                              <X className="h-4 w-4" />
                            </Button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
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
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        Sending...
                      </>
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
