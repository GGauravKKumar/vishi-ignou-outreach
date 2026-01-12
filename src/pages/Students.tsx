import { useEffect, useState, useRef } from "react";
import { DashboardLayout } from "@/components/layout/DashboardLayout";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { Users, RefreshCw, Search, Upload, Trash2, FileSpreadsheet, Plus, Download, Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

interface Student {
  id: string;
  name: string;
  email: string;
  course: string;
  created_at: string;
}

interface ParsedStudent {
  name: string;
  email: string;
  course: string;
}

export default function Students() {
  const [students, setStudents] = useState<Student[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState("");
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [bulkDialogOpen, setBulkDialogOpen] = useState(false);
  const [newStudent, setNewStudent] = useState({ name: "", email: "", course: "" });
  const [adding, setAdding] = useState(false);
  const [bulkAdding, setBulkAdding] = useState(false);
  const [parsedStudents, setParsedStudents] = useState<ParsedStudent[]>([]);
  const [activeTab, setActiveTab] = useState("upload");
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Google Sheets config
  const [sheetUrl, setSheetUrl] = useState("");
  const [nameCol, setNameCol] = useState("A");
  const [emailCol, setEmailCol] = useState("B");
  const [courseCol, setCourseCol] = useState("C");

  useEffect(() => {
    fetchStudents();
  }, []);

  const fetchStudents = async () => {
    setLoading(true);
    const allStudents: Student[] = [];
    const pageSize = 1000;
    let page = 0;
    let hasMore = true;

    while (hasMore) {
      const { data, error } = await supabase
        .from("students")
        .select("*")
        .order("created_at", { ascending: false })
        .range(page * pageSize, (page + 1) * pageSize - 1);

      if (error) {
        toast.error("Failed to fetch students");
        console.error(error);
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

    setStudents(allStudents);
    setLoading(false);
  };

  const handleAddStudent = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newStudent.name || !newStudent.email || !newStudent.course) {
      toast.error("Please fill all fields");
      return;
    }

    setAdding(true);
    const { error } = await supabase.from("students").insert([newStudent]);

    if (error) {
      toast.error("Failed to add student");
      console.error(error);
    } else {
      toast.success("Student added successfully");
      setNewStudent({ name: "", email: "", course: "" });
      setAddDialogOpen(false);
      fetchStudents();
    }
    setAdding(false);
  };

  const handleDeleteStudent = async (id: string) => {
    const { error } = await supabase.from("students").delete().eq("id", id);
    if (error) {
      toast.error("Failed to delete student");
    } else {
      toast.success("Student deleted");
      setStudents(students.filter((s) => s.id !== id));
    }
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const text = event.target?.result as string;
        const rows = text.split("\n").filter((row) => row.trim());
        
        // Skip header row if it looks like headers
        const startIndex = rows[0]?.toLowerCase().includes("name") || 
                          rows[0]?.toLowerCase().includes("email") ? 1 : 0;
        
        const parsed: ParsedStudent[] = [];
        
        for (let i = startIndex; i < rows.length; i++) {
          const cols = rows[i].split(/[,\t]/).map((c) => c.trim().replace(/^["']|["']$/g, ""));
          if (cols.length >= 3 && cols[0] && cols[1] && cols[2]) {
            // Basic email validation
            if (cols[1].includes("@")) {
              parsed.push({
                name: cols[0],
                email: cols[1],
                course: cols[2],
              });
            }
          }
        }

        if (parsed.length === 0) {
          toast.error("No valid students found. Ensure CSV has: Name, Email, Course columns");
          return;
        }

        setParsedStudents(parsed);
        toast.success(`Found ${parsed.length} students ready to import`);
      } catch (err) {
        toast.error("Failed to parse file. Please use CSV format.");
        console.error(err);
      }
    };
    reader.readAsText(file);
  };

  const handleBulkImport = async () => {
    if (parsedStudents.length === 0) {
      toast.error("No students to import");
      return;
    }

    setBulkAdding(true);
    
    const { error } = await supabase.from("students").insert(parsedStudents);

    if (error) {
      toast.error("Failed to import students");
      console.error(error);
    } else {
      toast.success(`Successfully imported ${parsedStudents.length} students`);
      setParsedStudents([]);
      setBulkDialogOpen(false);
      fetchStudents();
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    }
    setBulkAdding(false);
  };

  const downloadTemplate = () => {
    const csv = "Name,Email,Course\nJohn Doe,john@example.com,BCA\nJane Smith,jane@example.com,MCA";
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "students_template.csv";
    a.click();
    URL.revokeObjectURL(url);
  };

  const filteredStudents = students.filter(
    (s) =>
      s.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      s.email.toLowerCase().includes(searchTerm.toLowerCase()) ||
      s.course.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const uniqueCourses = [...new Set(students.map((s) => s.course))];

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-2xl font-bold">Students</h1>
            <p className="text-muted-foreground">
              Manage student data - add manually or import in bulk
            </p>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={fetchStudents}>
              <RefreshCw className="mr-2 h-4 w-4" />
              Refresh
            </Button>
            
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button className="gradient-primary">
                  <Plus className="mr-2 h-4 w-4" />
                  Add Students
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => setAddDialogOpen(true)}>
                  <Plus className="mr-2 h-4 w-4" />
                  Add Single Student
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setBulkDialogOpen(true)}>
                  <FileSpreadsheet className="mr-2 h-4 w-4" />
                  Bulk Import (CSV/Excel)
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        {/* Single Student Dialog */}
        <Dialog open={addDialogOpen} onOpenChange={setAddDialogOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Add New Student</DialogTitle>
              <DialogDescription>
                Add a student manually to the database
              </DialogDescription>
            </DialogHeader>
            <form onSubmit={handleAddStudent}>
              <div className="space-y-4 py-4">
                <div className="space-y-2">
                  <Label htmlFor="name">Name</Label>
                  <Input
                    id="name"
                    placeholder="Student name"
                    value={newStudent.name}
                    onChange={(e) => setNewStudent({ ...newStudent, name: e.target.value })}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="email">Email</Label>
                  <Input
                    id="email"
                    type="email"
                    placeholder="student@email.com"
                    value={newStudent.email}
                    onChange={(e) => setNewStudent({ ...newStudent, email: e.target.value })}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="course">Course</Label>
                  <Input
                    id="course"
                    placeholder="e.g., BCA, MCA, BA"
                    value={newStudent.course}
                    onChange={(e) => setNewStudent({ ...newStudent, course: e.target.value })}
                  />
                </div>
              </div>
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setAddDialogOpen(false)}>
                  Cancel
                </Button>
                <Button type="submit" className="gradient-primary" disabled={adding}>
                  {adding ? "Adding..." : "Add Student"}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>

        {/* Bulk Import Dialog */}
        <Dialog open={bulkDialogOpen} onOpenChange={(open) => {
          setBulkDialogOpen(open);
          if (!open) {
            setParsedStudents([]);
            setActiveTab("upload");
          }
        }}>
          <DialogContent className="max-w-2xl">
            <DialogHeader>
              <DialogTitle>Bulk Import Students</DialogTitle>
              <DialogDescription>
                Import students from a CSV or Excel file
              </DialogDescription>
            </DialogHeader>
            
            <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
              <TabsList className="grid w-full grid-cols-2">
                <TabsTrigger value="upload">Upload File</TabsTrigger>
                <TabsTrigger value="google">Google Sheets</TabsTrigger>
              </TabsList>
              
              <TabsContent value="upload" className="space-y-4 pt-4">
                <div className="space-y-4">
                  <div className="rounded-lg border-2 border-dashed border-muted-foreground/25 p-6 text-center">
                    <FileSpreadsheet className="mx-auto h-10 w-10 text-muted-foreground/50" />
                    <p className="mt-2 text-sm text-muted-foreground">
                      Upload a CSV file with columns: Name, Email, Course
                    </p>
                    <div className="mt-4 flex justify-center gap-2">
                      <Input
                        ref={fileInputRef}
                        type="file"
                        accept=".csv,.txt"
                        onChange={handleFileUpload}
                        className="max-w-xs"
                      />
                    </div>
                    <Button
                      variant="link"
                      size="sm"
                      onClick={downloadTemplate}
                      className="mt-2"
                    >
                      <Download className="mr-1 h-3 w-3" />
                      Download Template
                    </Button>
                  </div>

                  {parsedStudents.length > 0 && (
                    <div className="space-y-2">
                      <p className="text-sm font-medium">
                        Preview ({parsedStudents.length} students):
                      </p>
                      <div className="max-h-48 overflow-y-auto rounded-md border">
                        <Table>
                          <TableHeader>
                            <TableRow>
                              <TableHead>Name</TableHead>
                              <TableHead>Email</TableHead>
                              <TableHead>Course</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {parsedStudents.slice(0, 5).map((s, i) => (
                              <TableRow key={i}>
                                <TableCell>{s.name}</TableCell>
                                <TableCell>{s.email}</TableCell>
                                <TableCell>{s.course}</TableCell>
                              </TableRow>
                            ))}
                            {parsedStudents.length > 5 && (
                              <TableRow>
                                <TableCell colSpan={3} className="text-center text-muted-foreground">
                                  ... and {parsedStudents.length - 5} more
                                </TableCell>
                              </TableRow>
                            )}
                          </TableBody>
                        </Table>
                      </div>
                    </div>
                  )}
                </div>
              </TabsContent>
              
              <TabsContent value="google" className="space-y-4 pt-4">
                <div className="space-y-4">
                  <p className="text-sm text-muted-foreground">
                    Google Sheets integration requires additional setup. For now, please export your Google Sheet as CSV and use the Upload option.
                  </p>
                  <div className="rounded-lg bg-muted/50 p-4">
                    <h4 className="font-medium">How to export from Google Sheets:</h4>
                    <ol className="mt-2 list-inside list-decimal text-sm text-muted-foreground space-y-1">
                      <li>Open your Google Sheet</li>
                      <li>Go to File → Download → Comma Separated Values (.csv)</li>
                      <li>Upload the downloaded file using the Upload tab</li>
                    </ol>
                  </div>
                </div>
              </TabsContent>
            </Tabs>

            <DialogFooter>
              <Button variant="outline" onClick={() => setBulkDialogOpen(false)}>
                Cancel
              </Button>
              <Button 
                className="gradient-primary" 
                onClick={handleBulkImport}
                disabled={bulkAdding || parsedStudents.length === 0}
              >
                {bulkAdding ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Importing...
                  </>
                ) : (
                  <>
                    <Upload className="mr-2 h-4 w-4" />
                    Import {parsedStudents.length} Students
                  </>
                )}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Stats */}
        <div className="grid gap-4 sm:grid-cols-3">
          <Card className="shadow-card">
            <CardContent className="flex items-center gap-4 p-6">
              <div className="rounded-xl bg-primary/10 p-3">
                <Users className="h-6 w-6 text-primary" />
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Total Students</p>
                <p className="text-2xl font-bold">{students.length}</p>
              </div>
            </CardContent>
          </Card>
          <Card className="shadow-card">
            <CardContent className="flex items-center gap-4 p-6">
              <div className="rounded-xl bg-secondary/10 p-3">
                <Users className="h-6 w-6 text-secondary" />
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Unique Courses</p>
                <p className="text-2xl font-bold">{uniqueCourses.length}</p>
              </div>
            </CardContent>
          </Card>
          <Card className="shadow-card">
            <CardContent className="flex items-center gap-4 p-6">
              <div className="rounded-xl bg-success/10 p-3">
                <Search className="h-6 w-6 text-success" />
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Filtered Results</p>
                <p className="text-2xl font-bold">{filteredStudents.length}</p>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Search */}
        <div className="relative max-w-md">
          <Search className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search by name, email, or course..."
            className="pl-10"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
          />
        </div>

        {/* Table */}
        <Card className="shadow-card">
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>Course</TableHead>
                  <TableHead>Added</TableHead>
                  <TableHead className="w-16"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading ? (
                  <TableRow>
                    <TableCell colSpan={5} className="text-center py-8">
                      <Loader2 className="mx-auto h-6 w-6 animate-spin text-primary" />
                      <p className="mt-2 text-muted-foreground">Loading students...</p>
                    </TableCell>
                  </TableRow>
                ) : filteredStudents.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={5} className="text-center py-8">
                      <Users className="mx-auto h-12 w-12 text-muted-foreground/50" />
                      <p className="mt-2 text-muted-foreground">No students found</p>
                      <Button 
                        variant="link" 
                        className="mt-2"
                        onClick={() => setBulkDialogOpen(true)}
                      >
                        Import students from CSV
                      </Button>
                    </TableCell>
                  </TableRow>
                ) : (
                  filteredStudents.map((student) => (
                    <TableRow key={student.id}>
                      <TableCell className="font-medium">{student.name}</TableCell>
                      <TableCell>{student.email}</TableCell>
                      <TableCell>
                        <span className="rounded-full bg-accent px-2.5 py-1 text-xs font-medium text-accent-foreground">
                          {student.course}
                        </span>
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {new Date(student.created_at).toLocaleDateString()}
                      </TableCell>
                      <TableCell>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="text-destructive hover:bg-destructive/10"
                          onClick={() => handleDeleteStudent(student.id)}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  );
}