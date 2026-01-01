import { useEffect, useState } from "react";
import { DashboardLayout } from "@/components/layout/DashboardLayout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { useAuth } from "@/hooks/useAuth";
import { FileText, Plus, Edit2, Trash2, BookOpen, Briefcase, GraduationCap, HelpCircle } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface EmailTemplate {
  id: string;
  name: string;
  subject: string;
  body: string;
  service_type: string;
  created_at: string;
}

const serviceTypes = [
  { value: "assignment", label: "Assignment Help", icon: BookOpen },
  { value: "project", label: "Project Assistance", icon: Briefcase },
  { value: "exam", label: "Exam Support", icon: GraduationCap },
  { value: "admission", label: "Admission Guidance", icon: HelpCircle },
];

const defaultTemplates = {
  assignment: {
    subject: "Get Expert Help with Your IGNOU Assignments - {{course}}",
    body: `Dear {{name}},

Greetings from Vishi IGNOU Services!

We hope you're making great progress in your {{course}} program at IGNOU. We understand that managing assignments alongside other responsibilities can be challenging.

That's why we're here to help! Our team of experienced professionals can assist you with:

✅ Well-researched and properly formatted assignments
✅ 100% plagiarism-free content
✅ On-time delivery before deadlines
✅ Affordable pricing with quality assurance

Don't let assignment stress hold you back. Let us help you achieve academic success!

📞 Contact us today to get started.

Best regards,
Vishi IGNOU Services Team`,
  },
  project: {
    subject: "Professional Project Assistance for {{course}} Students",
    body: `Dear {{name}},

Greetings from Vishi IGNOU Services!

Are you working on your project for {{course}}? We're here to make your journey smoother!

Our project assistance includes:

🔹 Topic selection and research guidance
🔹 Complete project report writing
🔹 Synopsis preparation
🔹 Presentation slides
🔹 Viva preparation support

With our expert guidance, you'll submit a project that stands out!

Get in touch with us today.

Warm regards,
Vishi IGNOU Services Team`,
  },
  exam: {
    subject: "Ace Your IGNOU Exams - Study Materials & Support",
    body: `Dear {{name}},

Hope your {{course}} studies are going well!

Exam season approaching? Vishi IGNOU Services has got you covered with:

📚 Comprehensive study materials
📝 Previous year solved papers
✨ Important questions compilation
🎯 Exam tips and strategies

Success is just one step away. Let us help you prepare effectively!

Contact us for more details.

Best wishes,
Vishi IGNOU Services Team`,
  },
  admission: {
    subject: "Your IGNOU Admission Guide - Start Your Educational Journey",
    body: `Dear {{name}},

Welcome to your educational journey with IGNOU!

Confused about the admission process? We can help with:

📋 Course selection guidance
📝 Application assistance
📄 Document verification
🔄 Re-registration support
📞 Query resolution

IGNOU offers excellent programs, and we're here to ensure you get enrolled smoothly in {{course}} or any program of your choice!

Reach out to us anytime.

Best regards,
Vishi IGNOU Services Team`,
  },
};

export default function Templates() {
  const { user } = useAuth();
  const [templates, setTemplates] = useState<EmailTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState<EmailTemplate | null>(null);
  const [saving, setSaving] = useState(false);

  const [formData, setFormData] = useState({
    name: "",
    subject: "",
    body: "",
    service_type: "assignment",
  });

  useEffect(() => {
    fetchTemplates();
  }, []);

  const fetchTemplates = async () => {
    const { data, error } = await supabase
      .from("email_templates")
      .select("*")
      .order("created_at", { ascending: false });

    if (error) {
      toast.error("Failed to fetch templates");
    } else {
      setTemplates(data || []);
    }
    setLoading(false);
  };

  const handleServiceTypeChange = (value: string) => {
    setFormData({
      ...formData,
      service_type: value,
      subject: defaultTemplates[value as keyof typeof defaultTemplates]?.subject || "",
      body: defaultTemplates[value as keyof typeof defaultTemplates]?.body || "",
    });
  };

  const openCreateDialog = () => {
    setEditingTemplate(null);
    setFormData({
      name: "",
      subject: defaultTemplates.assignment.subject,
      body: defaultTemplates.assignment.body,
      service_type: "assignment",
    });
    setDialogOpen(true);
  };

  const openEditDialog = (template: EmailTemplate) => {
    setEditingTemplate(template);
    setFormData({
      name: template.name,
      subject: template.subject,
      body: template.body,
      service_type: template.service_type,
    });
    setDialogOpen(true);
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.name || !formData.subject || !formData.body) {
      toast.error("Please fill all fields");
      return;
    }

    setSaving(true);

    if (editingTemplate) {
      const { error } = await supabase
        .from("email_templates")
        .update(formData)
        .eq("id", editingTemplate.id);

      if (error) {
        toast.error("Failed to update template");
      } else {
        toast.success("Template updated successfully");
        setDialogOpen(false);
        fetchTemplates();
      }
    } else {
      const { error } = await supabase.from("email_templates").insert([
        {
          ...formData,
          created_by: user?.id,
        },
      ]);

      if (error) {
        toast.error("Failed to create template");
      } else {
        toast.success("Template created successfully");
        setDialogOpen(false);
        fetchTemplates();
      }
    }
    setSaving(false);
  };

  const handleDelete = async (id: string) => {
    const { error } = await supabase.from("email_templates").delete().eq("id", id);
    if (error) {
      toast.error("Failed to delete template");
    } else {
      toast.success("Template deleted");
      setTemplates(templates.filter((t) => t.id !== id));
    }
  };

  const getServiceIcon = (type: string) => {
    const service = serviceTypes.find((s) => s.value === type);
    return service?.icon || FileText;
  };

  const getServiceLabel = (type: string) => {
    const service = serviceTypes.find((s) => s.value === type);
    return service?.label || type;
  };

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-2xl font-bold">Email Templates</h1>
            <p className="text-muted-foreground">
              Create and manage templates for different services
            </p>
          </div>
          <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
            <DialogTrigger asChild>
              <Button className="gradient-primary" onClick={openCreateDialog}>
                <Plus className="mr-2 h-4 w-4" />
                Create Template
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
              <DialogHeader>
                <DialogTitle>
                  {editingTemplate ? "Edit Template" : "Create New Template"}
                </DialogTitle>
                <DialogDescription>
                  Use {"{{name}}"}, {"{{email}}"}, and {"{{course}}"} as personalization variables
                </DialogDescription>
              </DialogHeader>
              <form onSubmit={handleSave}>
                <div className="space-y-4 py-4">
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div className="space-y-2">
                      <Label htmlFor="name">Template Name</Label>
                      <Input
                        id="name"
                        placeholder="e.g., Assignment Promo"
                        value={formData.name}
                        onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="service_type">Service Type</Label>
                      <Select
                        value={formData.service_type}
                        onValueChange={handleServiceTypeChange}
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {serviceTypes.map((service) => (
                            <SelectItem key={service.value} value={service.value}>
                              {service.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="subject">Email Subject</Label>
                    <Input
                      id="subject"
                      placeholder="Email subject line..."
                      value={formData.subject}
                      onChange={(e) => setFormData({ ...formData, subject: e.target.value })}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="body">Email Body</Label>
                    <Textarea
                      id="body"
                      placeholder="Write your email content..."
                      className="min-h-[300px] font-mono text-sm"
                      value={formData.body}
                      onChange={(e) => setFormData({ ...formData, body: e.target.value })}
                    />
                  </div>
                </div>
                <DialogFooter>
                  <Button type="button" variant="outline" onClick={() => setDialogOpen(false)}>
                    Cancel
                  </Button>
                  <Button type="submit" className="gradient-primary" disabled={saving}>
                    {saving ? "Saving..." : editingTemplate ? "Update Template" : "Create Template"}
                  </Button>
                </DialogFooter>
              </form>
            </DialogContent>
          </Dialog>
        </div>

        {/* Templates Grid */}
        {loading ? (
          <div className="text-center py-12">Loading templates...</div>
        ) : templates.length === 0 ? (
          <Card className="shadow-card">
            <CardContent className="flex flex-col items-center justify-center py-12">
              <FileText className="h-12 w-12 text-muted-foreground/50" />
              <p className="mt-4 text-lg font-medium">No templates yet</p>
              <p className="text-muted-foreground">Create your first email template to get started</p>
              <Button className="mt-4 gradient-primary" onClick={openCreateDialog}>
                <Plus className="mr-2 h-4 w-4" />
                Create Template
              </Button>
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {templates.map((template) => {
              const ServiceIcon = getServiceIcon(template.service_type);
              return (
                <Card key={template.id} className="shadow-card transition-transform hover:scale-[1.02]">
                  <CardHeader className="pb-3">
                    <div className="flex items-start justify-between">
                      <div className="flex items-center gap-3">
                        <div className="rounded-lg bg-primary/10 p-2">
                          <ServiceIcon className="h-5 w-5 text-primary" />
                        </div>
                        <div>
                          <CardTitle className="text-base">{template.name}</CardTitle>
                          <CardDescription className="text-xs">
                            {getServiceLabel(template.service_type)}
                          </CardDescription>
                        </div>
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent>
                    <p className="text-sm text-muted-foreground line-clamp-2 mb-4">
                      {template.subject}
                    </p>
                    <div className="flex gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        className="flex-1"
                        onClick={() => openEditDialog(template)}
                      >
                        <Edit2 className="mr-1 h-3 w-3" />
                        Edit
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="text-destructive hover:bg-destructive/10"
                        onClick={() => handleDelete(template.id)}
                      >
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}
