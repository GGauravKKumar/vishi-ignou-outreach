import { DashboardLayout } from "@/components/layout/DashboardLayout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Settings as SettingsIcon, Mail, Link } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

export default function Settings() {
  const [smtpHost, setSmtpHost] = useState("smtpout.secureserver.net");
  const [smtpPort, setSmtpPort] = useState("587");
  const [smtpUser, setSmtpUser] = useState("");
  const [fromEmail, setFromEmail] = useState("");

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold">Settings</h1>
          <p className="text-muted-foreground">Configure your email and integration settings</p>
        </div>
        <Card className="shadow-card max-w-2xl">
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><Mail className="h-5 w-5 text-primary" />GoDaddy SMTP Settings</CardTitle>
            <CardDescription>Configure your GoDaddy email for sending campaigns</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2"><Label>SMTP Host</Label><Input value={smtpHost} onChange={(e) => setSmtpHost(e.target.value)} /></div>
              <div className="space-y-2"><Label>SMTP Port</Label><Input value={smtpPort} onChange={(e) => setSmtpPort(e.target.value)} /></div>
            </div>
            <div className="space-y-2"><Label>Username (Email)</Label><Input value={smtpUser} onChange={(e) => setSmtpUser(e.target.value)} placeholder="your@domain.com" /></div>
            <div className="space-y-2"><Label>From Email</Label><Input value={fromEmail} onChange={(e) => setFromEmail(e.target.value)} placeholder="noreply@domain.com" /></div>
            <Button className="gradient-primary" onClick={() => toast.info("SMTP password needs to be configured as a secret")}>Save Settings</Button>
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  );
}
