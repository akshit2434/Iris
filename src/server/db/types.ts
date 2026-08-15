import type { MessageRole } from "@/lib/types";

export type Database = {
  public: {
    Tables: {
      profiles: {
        Row: {
          id: "profile-a" | "profile-b";
          display_name: string;
          created_at: string;
        };
        Insert: {
          id: "profile-a" | "profile-b";
          display_name: string;
          created_at?: string;
        };
        Update: Partial<{
          id: "profile-a" | "profile-b";
          display_name: string;
          created_at: string;
        }>;
        Relationships: [];
      };
      threads: {
        Row: {
          id: string;
          profile_id: "profile-a" | "profile-b";
          title: string;
          created_at: string;
          updated_at: string;
          archived_at: string | null;
        };
        Insert: {
          id?: string;
          profile_id: "profile-a" | "profile-b";
          title?: string;
          created_at?: string;
          updated_at?: string;
          archived_at?: string | null;
        };
        Update: Partial<{
          id: string;
          profile_id: "profile-a" | "profile-b";
          title: string;
          created_at: string;
          updated_at: string;
          archived_at: string | null;
        }>;
        Relationships: [];
      };
      messages: {
        Row: {
          id: string;
          thread_id: string;
          profile_id: "profile-a" | "profile-b";
          role: MessageRole;
          content: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          thread_id: string;
          profile_id: "profile-a" | "profile-b";
          role: MessageRole;
          content: string;
          created_at?: string;
        };
        Update: Partial<{
          id: string;
          thread_id: string;
          profile_id: "profile-a" | "profile-b";
          role: MessageRole;
          content: string;
          created_at: string;
        }>;
        Relationships: [];
      };
      thread_context: {
        Row: {
          thread_id: string;
          profile_id: "profile-a" | "profile-b";
          continuity_summary: string | null;
          pinned_notes: string[];
          memory_revision_seen: number;
          updated_at: string;
        };
        Insert: {
          thread_id: string;
          profile_id: "profile-a" | "profile-b";
          continuity_summary?: string | null;
          pinned_notes?: string[];
          memory_revision_seen?: number;
          updated_at?: string;
        };
        Update: Partial<{
          thread_id: string;
          profile_id: "profile-a" | "profile-b";
          continuity_summary: string | null;
          pinned_notes: string[];
          memory_revision_seen: number;
          updated_at: string;
        }>;
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
};
