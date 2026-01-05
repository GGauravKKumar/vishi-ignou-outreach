-- Enable realtime for campaigns table to show live updates
ALTER PUBLICATION supabase_realtime ADD TABLE public.campaigns;

-- Add pending_count column to track pending emails
ALTER TABLE public.campaigns ADD COLUMN IF NOT EXISTS pending_count integer NOT NULL DEFAULT 0;