import type { MessageRole } from "@/lib/types";

export type Json =
  | boolean
  | number
  | string
  | null
  | { [key: string]: Json | undefined }
  | Json[];

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
          agent_run_id: string | null;
          is_complete: boolean;
          created_at: string;
        };
        Insert: {
          id?: string;
          thread_id: string;
          profile_id: "profile-a" | "profile-b";
          role: MessageRole;
          content: string;
          agent_run_id?: string | null;
          is_complete?: boolean;
          created_at?: string;
        };
        Update: Partial<{
          id: string;
          thread_id: string;
          profile_id: "profile-a" | "profile-b";
          role: MessageRole;
          content: string;
          agent_run_id: string | null;
          is_complete: boolean;
          created_at: string;
        }>;
        Relationships: [];
      };
      agent_runs: {
        Row: {
          id: string;
          profile_id: "profile-a" | "profile-b";
          thread_id: string;
          request_id: string;
          user_message_id: string | null;
          assistant_message_id: string | null;
          model: string;
          status: "running" | "completed" | "failed";
          started_at: string;
          completed_at: string | null;
          failed_at: string | null;
          error_code: string | null;
          error_message: string | null;
          error_metadata: Json;
          created_at: string;
        };
        Insert: {
          id?: string;
          profile_id: "profile-a" | "profile-b";
          thread_id: string;
          request_id: string;
          user_message_id?: string | null;
          assistant_message_id?: string | null;
          model: string;
          status?: "running" | "completed" | "failed";
          started_at?: string;
          completed_at?: string | null;
          failed_at?: string | null;
          error_code?: string | null;
          error_message?: string | null;
          error_metadata?: Json;
          created_at?: string;
        };
        Update: Partial<{
          id: string;
          profile_id: "profile-a" | "profile-b";
          thread_id: string;
          request_id: string;
          user_message_id: string | null;
          assistant_message_id: string | null;
          model: string;
          status: "running" | "completed" | "failed";
          started_at: string;
          completed_at: string | null;
          failed_at: string | null;
          error_code: string | null;
          error_message: string | null;
          error_metadata: Json;
          created_at: string;
        }>;
        Relationships: [];
      };
      agent_events: {
        Row: {
          id: string;
          profile_id: "profile-a" | "profile-b";
          thread_id: string;
          run_id: string;
          sequence: number;
          type: "run_started" | "run_completed" | "run_failed" | "tool_call" | "tool_result";
          payload: Json;
          created_at: string;
        };
        Insert: {
          id?: string;
          profile_id: "profile-a" | "profile-b";
          thread_id: string;
          run_id: string;
          sequence: number;
          type: "run_started" | "run_completed" | "run_failed" | "tool_call" | "tool_result";
          payload?: Json;
          created_at?: string;
        };
        Update: Partial<{
          id: string;
          profile_id: "profile-a" | "profile-b";
          thread_id: string;
          run_id: string;
          sequence: number;
          type: "run_started" | "run_completed" | "run_failed" | "tool_call" | "tool_result";
          payload: Json;
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
