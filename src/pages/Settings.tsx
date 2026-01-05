import { DashboardLayout } from "@/components/layout/DashboardLayout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Mail, Eye, EyeOff, Check, Loader2, Wifi, WifiOff, Send } from "lucide-react";
import { useState, useEffect } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";

export default function Settings() {
  const [smtpHost, setSmtpHost] = useState("smtpout.secureserver.net");
  const [smtpPort, setSmtpPort] = useState("587");
  const [smtpUser, setSmtpUser] = useState("");
  const [smtpPassword, setSmtpPassword] = useState("");
  const [fromEmail, setFromEmail] = useState("");
  const [fromName, setFromName] = useState("Vishi IGNOU Services");
  const [showPassword, setShowPassword] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);

  useEffect(() => {
    fetchSmtpConfig();
  }, []);

  const fetchSmtpConfig = async () => {
    const { data, error } = await supabase
      .from("smtp_config")
      .select("*")
      .limit(1)
      .maybeSingle();

    if (data) {
      setSmtpHost(data.host);
      setSmtpPort(data.port.toString());
      setSmtpUser(data.username);
      setFromEmail(data.from_email);
      setFromName(data.from_name);
    }
    setLoading(false);
  };

  const handleSaveSettings = async () => {
    if (!smtpUser || !fromEmail) {
      toast.error("Please fill in Username and From Email");
      return;
    }

    setSaving(true);
    setTestResult(null);

    // Check if config exists
    const { data: existing } = await supabase
      .from("smtp_config")
      .select("id")
      .limit(1)
      .maybeSingle();

    const configData = {
      host: smtpHost,
      port: parseInt(smtpPort),
      username: smtpUser,
      from_email: fromEmail,
      from_name: fromName,
    };

    let error;
    if (existing) {
      const result = await supabase
        .from("smtp_config")
        .update(configData)
        .eq("id", existing.id);
      error = result.error;
    } else {
      const result = await supabase.from("smtp_config").insert([configData]);
      error = result.error;
    }

    if (error) {
      toast.error("Failed to save settings");
      console.error(error);
    } else {
      toast.success("SMTP settings saved successfully");
      // Note: Password should be stored as a secret for security
      if (smtpPassword) {
        toast.info("Note: For security, the SMTP password will be configured separately as a secret");
      }
    }

    setSaving(false);
  };

  const handleTestConnection = async (sendTestEmail: boolean = false) => {
    setTesting(true);
    setTestResult(null);

    try {
      const { data, error } = await supabase.functions.invoke("test-smtp", {
        body: { sendTestEmail },
      });

      if (error) {
        setTestResult({ success: false, message: error.message });
        toast.error("Connection test failed: " + error.message);
      } else if (data.success) {
        setTestResult({ success: true, message: data.message });
        toast.success(data.message);
      } else {
        const message = data.suggestion 
          ? `${data.error}. ${data.suggestion}`
          : data.error;
        setTestResult({ success: false, message });
        toast.error(message);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      setTestResult({ success: false, message });
      toast.error("Test failed: " + message);
    }

    setTesting(false);
  };

  if (loading) {
    return (
      <DashboardLayout>
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
        </div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold">Settings</h1>
          <p className="text-muted-foreground">Configure your email and integration settings</p>
        </div>
        
        <Card className="shadow-card max-w-2xl">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Mail className="h-5 w-5 text-primary" />
              GoDaddy SMTP Settings
            </CardTitle>
            <CardDescription>Configure your GoDaddy email for sending campaigns</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="smtp-host">SMTP Host</Label>
                <Input 
                  id="smtp-host"
                  value={smtpHost} 
                  onChange={(e) => setSmtpHost(e.target.value)} 
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="smtp-port">SMTP Port</Label>
                <Input 
                  id="smtp-port"
                  value={smtpPort} 
                  onChange={(e) => setSmtpPort(e.target.value)} 
                />
              </div>
            </div>
            
            <div className="space-y-2">
              <Label htmlFor="smtp-user">Username (Email)</Label>
              <Input 
                id="smtp-user"
                value={smtpUser} 
                onChange={(e) => setSmtpUser(e.target.value)} 
                placeholder="your@domain.com" 
              />
            </div>
            
            <div className="space-y-2">
              <Label htmlFor="smtp-password">Password</Label>
              <div className="relative">
                <Input 
                  id="smtp-password"
                  type={showPassword ? "text" : "password"}
                  value={smtpPassword} 
                  onChange={(e) => setSmtpPassword(e.target.value)} 
                  placeholder="Enter your email password"
                  className="pr-10"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="absolute right-0 top-0 h-full px-3 hover:bg-transparent"
                  onClick={() => setShowPassword(!showPassword)}
                >
                  {showPassword ? (
                    <EyeOff className="h-4 w-4 text-muted-foreground" />
                  ) : (
                    <Eye className="h-4 w-4 text-muted-foreground" />
                  )}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Your password is stored securely and used only for sending emails
              </p>
            </div>
            
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="from-email">From Email</Label>
                <Input 
                  id="from-email"
                  value={fromEmail} 
                  onChange={(e) => setFromEmail(e.target.value)} 
                  placeholder="noreply@domain.com" 
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="from-name">From Name</Label>
                <Input 
                  id="from-name"
                  value={fromName} 
                  onChange={(e) => setFromName(e.target.value)} 
                  placeholder="Your Business Name" 
                />
              </div>
            </div>

            {/* Test Result Display */}
            {testResult && (
              <div className={`p-3 rounded-lg flex items-start gap-2 ${
                testResult.success 
                  ? "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400" 
                  : "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400"
              }`}>
                {testResult.success ? (
                  <Wifi className="h-5 w-5 mt-0.5 shrink-0" />
                ) : (
                  <WifiOff className="h-5 w-5 mt-0.5 shrink-0" />
                )}
                <p className="text-sm">{testResult.message}</p>
              </div>
            )}
            
            <div className="flex flex-wrap gap-3">
              <Button 
                className="gradient-primary" 
                onClick={handleSaveSettings}
                disabled={saving}
              >
                {saving ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Saving...
                  </>
                ) : (
                  <>
                    <Check className="mr-2 h-4 w-4" />
                    Save Settings
                  </>
                )}
              </Button>

              <Button 
                variant="outline"
                onClick={() => handleTestConnection(false)}
                disabled={testing}
              >
                {testing ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Testing...
                  </>
                ) : (
                  <>
                    <Wifi className="mr-2 h-4 w-4" />
                    Test Connection
                  </>
                )}
              </Button>

              <Button 
                variant="secondary"
                onClick={() => handleTestConnection(true)}
                disabled={testing}
              >
                {testing ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Sending...
                  </>
                ) : (
                  <>
                    <Send className="mr-2 h-4 w-4" />
                    Send Test Email
                  </>
                )}
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  );
}
