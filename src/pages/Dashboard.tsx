import { useEffect, useState } from "react";
import { useAuth } from "@/hooks/useAuth";
import { DashboardLayout } from "@/components/layout/DashboardLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { supabase } from "@/integrations/supabase/client";
import { Users, Mail, CheckCircle, XCircle, TrendingUp, Send } from "lucide-react";

interface DashboardStats {
  totalStudents: number;
  totalCampaigns: number;
  emailsSent: number;
  emailsFailed: number;
}

export default function Dashboard() {
  const { user } = useAuth();
  const [stats, setStats] = useState<DashboardStats>({
    totalStudents: 0,
    totalCampaigns: 0,
    emailsSent: 0,
    emailsFailed: 0,
  });
  const [recentCampaigns, setRecentCampaigns] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchDashboardData();
  }, []);

  const fetchDashboardData = async () => {
    try {
      const [studentsRes, campaignsRes, emailLogsRes] = await Promise.all([
        supabase.from("students").select("id", { count: "exact", head: true }),
        supabase.from("campaigns").select("*").order("created_at", { ascending: false }).limit(5),
        supabase.from("email_logs").select("status"),
      ]);

      const sentCount = emailLogsRes.data?.filter((l) => l.status === "sent").length || 0;
      const failedCount = emailLogsRes.data?.filter((l) => l.status === "failed").length || 0;

      setStats({
        totalStudents: studentsRes.count || 0,
        totalCampaigns: campaignsRes.data?.length || 0,
        emailsSent: sentCount,
        emailsFailed: failedCount,
      });

      setRecentCampaigns(campaignsRes.data || []);
    } catch (error) {
      console.error("Error fetching dashboard data:", error);
    } finally {
      setLoading(false);
    }
  };

  const statCards = [
    {
      title: "Total Students",
      value: stats.totalStudents,
      icon: Users,
      color: "text-primary",
      bgColor: "bg-primary/10",
    },
    {
      title: "Campaigns Sent",
      value: stats.totalCampaigns,
      icon: Send,
      color: "text-secondary",
      bgColor: "bg-secondary/10",
    },
    {
      title: "Emails Delivered",
      value: stats.emailsSent,
      icon: CheckCircle,
      color: "text-success",
      bgColor: "bg-success/10",
    },
    {
      title: "Emails Failed",
      value: stats.emailsFailed,
      icon: XCircle,
      color: "text-destructive",
      bgColor: "bg-destructive/10",
    },
  ];

  return (
    <DashboardLayout>
      <div className="space-y-6">
        {/* Welcome Section */}
        <div className="rounded-xl gradient-primary p-6 text-primary-foreground shadow-glow">
          <h1 className="text-2xl font-bold">Welcome back!</h1>
          <p className="mt-1 text-primary-foreground/80">
            Manage your email campaigns and reach IGNOU students effectively.
          </p>
        </div>

        {/* Stats Grid */}
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {statCards.map((stat) => (
            <Card key={stat.title} className="shadow-card transition-transform hover:scale-[1.02]">
              <CardContent className="flex items-center gap-4 p-6">
                <div className={`rounded-xl p-3 ${stat.bgColor}`}>
                  <stat.icon className={`h-6 w-6 ${stat.color}`} />
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">{stat.title}</p>
                  <p className="text-2xl font-bold">{stat.value}</p>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>

        {/* Recent Campaigns */}
        <Card className="shadow-card">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <TrendingUp className="h-5 w-5 text-primary" />
              Recent Campaigns
            </CardTitle>
          </CardHeader>
          <CardContent>
            {recentCampaigns.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <Mail className="h-12 w-12 text-muted-foreground/50" />
                <p className="mt-4 text-lg font-medium">No campaigns yet</p>
                <p className="text-muted-foreground">
                  Create your first campaign to start reaching students
                </p>
              </div>
            ) : (
              <div className="space-y-3">
                {recentCampaigns.map((campaign) => (
                  <div
                    key={campaign.id}
                    className="flex items-center justify-between rounded-lg border border-border p-4"
                  >
                    <div>
                      <p className="font-medium">{campaign.name}</p>
                      <p className="text-sm text-muted-foreground">
                        {new Date(campaign.created_at).toLocaleDateString()}
                      </p>
                    </div>
                    <div className="flex items-center gap-4 text-sm">
                      <span className="text-success">{campaign.sent_count} sent</span>
                      {campaign.failed_count > 0 && (
                        <span className="text-destructive">{campaign.failed_count} failed</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  );
}
