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
          title_source: "default" | "automatic" | "manual";
          title_generation_attempted: boolean;
          created_at: string;
          updated_at: string;
          archived_at: string | null;
        };
        Insert: {
          id?: string;
          profile_id: "profile-a" | "profile-b";
          title?: string;
          title_source?: "default" | "automatic" | "manual";
          title_generation_attempted?: boolean;
          created_at?: string;
          updated_at?: string;
          archived_at?: string | null;
        };
        Update: Partial<{
          id: string;
          profile_id: "profile-a" | "profile-b";
          title: string;
          title_source: "default" | "automatic" | "manual";
          title_generation_attempted: boolean;
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
          search_vector: string | null;
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
          compacted_through_message_id: string | null;
          compacted_through_created_at: string | null;
          continuity_revision: number;
          updated_at: string;
        };
        Insert: {
          thread_id: string;
          profile_id: "profile-a" | "profile-b";
          continuity_summary?: string | null;
          pinned_notes?: string[];
          memory_revision_seen?: number;
          compacted_through_message_id?: string | null;
          compacted_through_created_at?: string | null;
          continuity_revision?: number;
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
      profile_memory_state: {
        Row: {
          profile_id: "profile-a" | "profile-b";
          current_revision: number;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          profile_id: "profile-a" | "profile-b";
          current_revision?: number;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<{
          profile_id: "profile-a" | "profile-b";
          current_revision: number;
          created_at: string;
          updated_at: string;
        }>;
        Relationships: [];
      };
      memory_items: {
        Row: {
          id: string;
          profile_id: "profile-a" | "profile-b";
          canonical_key: string;
          content: string;
          item_revision: number;
          category: "personal_fact" | "preference" | "instruction" | "project" | "goal" | "relationship" | "active_state" | "pattern" | "other";
          value_scope: "single" | "multi";
          origin: "explicit" | "inferred" | "system";
          confidence: number;
          importance: number;
          sensitivity: "normal" | "sensitive" | "highly_sensitive";
          status: "active" | "superseded" | "archived" | "deleted";
          valid_from: string | null;
          valid_until: string | null;
          last_confirmed_at: string | null;
          superseded_by_item_id: string | null;
          created_at: string;
          updated_at: string;
          archived_at: string | null;
          deleted_at: string | null;
        };
        Insert: {
          id?: string;
          profile_id: "profile-a" | "profile-b";
          canonical_key: string;
          content: string;
          item_revision?: number;
          category?: Database["public"]["Tables"]["memory_items"]["Row"]["category"];
          value_scope?: Database["public"]["Tables"]["memory_items"]["Row"]["value_scope"];
          origin?: Database["public"]["Tables"]["memory_items"]["Row"]["origin"];
          confidence?: number;
          importance?: number;
          sensitivity?: Database["public"]["Tables"]["memory_items"]["Row"]["sensitivity"];
          status?: Database["public"]["Tables"]["memory_items"]["Row"]["status"];
          valid_from?: string | null;
          valid_until?: string | null;
          last_confirmed_at?: string | null;
          superseded_by_item_id?: string | null;
          created_at?: string;
          updated_at?: string;
          archived_at?: string | null;
          deleted_at?: string | null;
        };
        Update: Partial<Database["public"]["Tables"]["memory_items"]["Insert"]>;
        Relationships: [];
      };
      memory_item_revisions: {
        Row: {
          id: string;
          profile_id: "profile-a" | "profile-b";
          item_id: string;
          item_revision: number;
          profile_global_revision: number;
          canonical_key: string;
          content: string;
          content_hash: string;
          category: Database["public"]["Tables"]["memory_items"]["Row"]["category"];
          value_scope: Database["public"]["Tables"]["memory_items"]["Row"]["value_scope"];
          origin: Database["public"]["Tables"]["memory_items"]["Row"]["origin"];
          confidence: number;
          importance: number;
          sensitivity: Database["public"]["Tables"]["memory_items"]["Row"]["sensitivity"];
          status: Database["public"]["Tables"]["memory_items"]["Row"]["status"];
          valid_from: string | null;
          valid_until: string | null;
          last_confirmed_at: string | null;
          superseded_by_item_id: string | null;
          mutation_kind: "create" | "update" | "supersede" | "archive" | "restore" | "delete" | "merge";
          idempotency_key: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          profile_id: "profile-a" | "profile-b";
          item_id: string;
          item_revision: number;
          profile_global_revision: number;
          canonical_key: string;
          content: string;
          content_hash: string;
          category: Database["public"]["Tables"]["memory_items"]["Row"]["category"];
          value_scope: Database["public"]["Tables"]["memory_items"]["Row"]["value_scope"];
          origin: Database["public"]["Tables"]["memory_items"]["Row"]["origin"];
          confidence: number;
          importance: number;
          sensitivity: Database["public"]["Tables"]["memory_items"]["Row"]["sensitivity"];
          status: Database["public"]["Tables"]["memory_items"]["Row"]["status"];
          valid_from?: string | null;
          valid_until?: string | null;
          last_confirmed_at?: string | null;
          superseded_by_item_id?: string | null;
          mutation_kind: "create" | "update" | "supersede" | "archive" | "restore" | "delete" | "merge";
          idempotency_key?: string | null;
          created_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["memory_item_revisions"]["Insert"]>;
        Relationships: [];
      };
      memory_item_sources: {
        Row: {
          id: string;
          profile_id: "profile-a" | "profile-b";
          item_id: string;
          revision_id: string;
          source_kind: "message" | "thread" | "agent_event" | "manual" | "system";
          source_thread_id: string | null;
          source_message_id: string | null;
          source_agent_event_id: string | null;
          source_agent_run_id: string | null;
          source_excerpt: string | null;
          metadata: Json;
          created_at: string;
        };
        Insert: {
          id?: string;
          profile_id: "profile-a" | "profile-b";
          item_id: string;
          revision_id: string;
          source_kind: "message" | "thread" | "agent_event" | "manual" | "system";
          source_thread_id?: string | null;
          source_message_id?: string | null;
          source_agent_event_id?: string | null;
          source_agent_run_id?: string | null;
          source_excerpt?: string | null;
          metadata?: Json;
          created_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["memory_item_sources"]["Insert"]>;
        Relationships: [];
      };
      memory_suppressions: {
        Row: {
          id: string;
          profile_id: "profile-a" | "profile-b";
          canonical_key: string;
          content_hash: string | null;
          item_id: string | null;
          reason: string;
          created_at: string;
          lifted_at: string | null;
        };
        Insert: {
          id?: string;
          profile_id: "profile-a" | "profile-b";
          canonical_key: string;
          content_hash?: string | null;
          item_id?: string | null;
          reason?: string;
          created_at?: string;
          lifted_at?: string | null;
        };
        Update: Partial<Database["public"]["Tables"]["memory_suppressions"]["Insert"]>;
        Relationships: [];
      };
      message_semantic_index: {
        Row: {
          message_id: string;
          profile_id: "profile-a" | "profile-b";
          thread_id: string;
          embedding: number[] | null;
          embedding_model: string | null;
          content_hash: string;
          indexed_at: string;
        };
        Insert: {
          message_id: string;
          profile_id: "profile-a" | "profile-b";
          thread_id: string;
          embedding?: number[] | null;
          embedding_model?: string | null;
          content_hash: string;
          indexed_at?: string;
        };
        Update: Partial<{
          message_id: string;
          profile_id: "profile-a" | "profile-b";
          thread_id: string;
          embedding: number[] | null;
          embedding_model: string | null;
          content_hash: string;
          indexed_at: string;
        }>;
        Relationships: [];
      };
      memory_consolidation_jobs: {
        Row: {
          id: string;
          profile_id: "profile-a" | "profile-b";
          thread_id: string;
          source_run_id: string;
          status: "pending" | "running" | "completed" | "failed" | "skipped";
          attempts: number;
          available_at: string;
          lease_expires_at: string | null;
          locked_at: string | null;
          locked_by: string | null;
          last_error_code: string | null;
          last_error_message: string | null;
          created_at: string;
          updated_at: string;
          completed_at: string | null;
        };
        Insert: {
          id?: string;
          profile_id: "profile-a" | "profile-b";
          thread_id: string;
          source_run_id: string;
          status?: "pending" | "running" | "completed" | "failed" | "skipped";
          attempts?: number;
          available_at?: string;
          lease_expires_at?: string | null;
          locked_at?: string | null;
          locked_by?: string | null;
          last_error_code?: string | null;
          last_error_message?: string | null;
          created_at?: string;
          updated_at?: string;
          completed_at?: string | null;
        };
        Update: Partial<{
          id: string;
          profile_id: "profile-a" | "profile-b";
          thread_id: string;
          source_run_id: string;
          status: "pending" | "running" | "completed" | "failed" | "skipped";
          attempts: number;
          available_at: string;
          lease_expires_at: string | null;
          locked_at: string | null;
          locked_by: string | null;
          last_error_code: string | null;
          last_error_message: string | null;
          created_at: string;
          updated_at: string;
          completed_at: string | null;
        }>;
        Relationships: [];
      };
      memory_mutation_proposals: {
        Row: {
          id: string;
          profile_id: "profile-a" | "profile-b";
          thread_id: string;
          source_run_id: string;
          job_id: string;
          proposal_index: number;
          idempotency_key: string;
          canonical_key: string;
          proposed_content: string;
          category: Database["public"]["Tables"]["memory_items"]["Row"]["category"];
          value_scope: Database["public"]["Tables"]["memory_items"]["Row"]["value_scope"];
          origin: Database["public"]["Tables"]["memory_items"]["Row"]["origin"];
          confidence: number;
          importance: number;
          sensitivity: Database["public"]["Tables"]["memory_items"]["Row"]["sensitivity"];
          expected_item_revision: number | null;
          mutation_kind: "create" | "update" | "supersede" | "merge";
          source_message_ids: string[];
          rationale: string | null;
          status: "proposed" | "applied" | "rejected" | "conflict";
          reason: string | null;
          result_revision_id: string | null;
          created_at: string;
          updated_at: string;
          applied_at: string | null;
        };
        Insert: {
          id?: string;
          profile_id: "profile-a" | "profile-b";
          thread_id: string;
          source_run_id: string;
          job_id: string;
          proposal_index: number;
          idempotency_key: string;
          canonical_key: string;
          proposed_content: string;
          category?: Database["public"]["Tables"]["memory_items"]["Row"]["category"];
          value_scope?: Database["public"]["Tables"]["memory_items"]["Row"]["value_scope"];
          origin?: Database["public"]["Tables"]["memory_items"]["Row"]["origin"];
          confidence?: number;
          importance?: number;
          sensitivity?: Database["public"]["Tables"]["memory_items"]["Row"]["sensitivity"];
          expected_item_revision?: number | null;
          mutation_kind: "create" | "update" | "supersede" | "merge";
          source_message_ids: string[];
          rationale?: string | null;
          status?: "proposed" | "applied" | "rejected" | "conflict";
          reason?: string | null;
          result_revision_id?: string | null;
          created_at?: string;
          updated_at?: string;
          applied_at?: string | null;
        };
        Update: Partial<{
          id: string;
          profile_id: "profile-a" | "profile-b";
          thread_id: string;
          source_run_id: string;
          job_id: string;
          proposal_index: number;
          idempotency_key: string;
          canonical_key: string;
          proposed_content: string;
          category: Database["public"]["Tables"]["memory_items"]["Row"]["category"];
          value_scope: Database["public"]["Tables"]["memory_items"]["Row"]["value_scope"];
          origin: Database["public"]["Tables"]["memory_items"]["Row"]["origin"];
          confidence: number;
          importance: number;
          sensitivity: Database["public"]["Tables"]["memory_items"]["Row"]["sensitivity"];
          expected_item_revision: number | null;
          mutation_kind: "create" | "update" | "supersede" | "merge";
          source_message_ids: string[];
          rationale: string | null;
          status: "proposed" | "applied" | "rejected" | "conflict";
          reason: string | null;
          result_revision_id: string | null;
          created_at: string;
          updated_at: string;
          applied_at: string | null;
        }>;
        Relationships: [];
      };
      thread_compaction_jobs: {
        Row: {
          id: string;
          profile_id: "profile-a" | "profile-b";
          thread_id: string;
          source_run_id: string;
          status: "pending" | "running" | "completed" | "failed" | "conflict" | "skipped";
          attempts: number;
          idempotency_key: string;
          expected_compacted_through_message_id: string | null;
          expected_continuity_revision: number;
          checkpoint_message_id: string;
          checkpoint_created_at: string;
          recent_tail_messages: number;
          available_at: string;
          lease_expires_at: string | null;
          locked_at: string | null;
          locked_by: string | null;
          last_error_code: string | null;
          last_error_message: string | null;
          created_at: string;
          updated_at: string;
          completed_at: string | null;
        };
        Insert: {
          id?: string;
          profile_id: "profile-a" | "profile-b";
          thread_id: string;
          source_run_id: string;
          status?: "pending" | "running" | "completed" | "failed" | "conflict" | "skipped";
          attempts?: number;
          idempotency_key: string;
          expected_compacted_through_message_id?: string | null;
          expected_continuity_revision?: number;
          checkpoint_message_id: string;
          checkpoint_created_at: string;
          recent_tail_messages?: number;
          available_at?: string;
          lease_expires_at?: string | null;
          locked_at?: string | null;
          locked_by?: string | null;
          last_error_code?: string | null;
          last_error_message?: string | null;
          created_at?: string;
          updated_at?: string;
          completed_at?: string | null;
        };
        Update: Partial<Database["public"]["Tables"]["thread_compaction_jobs"]["Insert"]>;
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: {
      create_thread_with_first_message: {
        Args: {
          p_profile_id: "profile-a" | "profile-b";
          p_thread_id: string;
          p_user_message_id: string;
          p_run_id: string;
          p_assistant_message_id: string;
          p_request_id: string;
          p_content: string;
          p_model: string;
        };
        Returns: Array<{
          thread_id: string;
          user_message_id: string;
          run_id: string;
          assistant_message_id: string;
          duplicate: boolean;
        }>;
      };
      search_messages: {
        Args: {
          p_profile_id: "profile-a" | "profile-b";
          p_query?: string;
          p_query_embedding?: number[] | null;
          p_thread_id?: string | null;
          p_from?: string | null;
          p_to?: string | null;
          p_limit?: number;
        };
        Returns: Array<{
          message_id: string;
          thread_id: string;
          profile_id: "profile-a" | "profile-b";
          role: MessageRole;
          content: string;
          created_at: string;
          lexical_score: number;
          semantic_score: number | null;
          combined_score: number;
        }>;
      };
      apply_memory_item_revision: {
        Args: {
          p_profile_id: "profile-a" | "profile-b";
          p_canonical_key: string;
          p_content: string;
          p_category?: "personal_fact" | "preference" | "instruction" | "project" | "goal" | "relationship" | "active_state" | "pattern" | "other";
          p_value_scope?: "single" | "multi";
          p_origin?: "explicit" | "inferred" | "system";
          p_confidence?: number;
          p_importance?: number;
          p_sensitivity?: string;
          p_status?: "active" | "superseded" | "archived" | "deleted";
          p_mutation_kind?: "create" | "update" | "supersede" | "archive" | "restore" | "delete" | "merge";
          p_expected_item_revision?: number | null;
          p_source_kind?: "message" | "thread" | "agent_event" | "manual" | "system";
          p_source_thread_id?: string | null;
          p_source_message_id?: string | null;
          p_source_agent_event_id?: string | null;
          p_source_agent_run_id?: string | null;
          p_source_excerpt?: string | null;
          p_source_metadata?: Json;
          p_idempotency_key?: string | null;
          p_superseded_by_item_id?: string | null;
        };
        Returns: Array<{
          profile_id: "profile-a" | "profile-b";
          item_id: string;
          canonical_key: string;
          item_revision: number;
          profile_global_revision: number;
          revision_id: string;
          source_id: string;
          content_hash: string;
        }>;
      };
      create_memory_suppression: {
        Args: { p_profile_id: "profile-a" | "profile-b"; p_canonical_key: string; p_content_hash?: string | null; p_item_id?: string | null; p_reason?: string };
        Returns: string;
      };
      lift_memory_suppression: {
        Args: { p_profile_id: "profile-a" | "profile-b"; p_canonical_key: string; p_content_hash?: string | null };
        Returns: number;
      };
      enqueue_memory_consolidation_job: {
        Args: { p_profile_id: "profile-a" | "profile-b"; p_thread_id: string; p_source_run_id: string };
        Returns: Array<Database["public"]["Tables"]["memory_consolidation_jobs"]["Row"]>;
      };
      claim_memory_consolidation_jobs: {
        Args: { p_worker_id: string; p_limit?: number; p_lease_seconds?: number };
        Returns: Array<Database["public"]["Tables"]["memory_consolidation_jobs"]["Row"]>;
      };
      finish_memory_consolidation_job: {
        Args: {
          p_profile_id: "profile-a" | "profile-b";
          p_job_id: string;
          p_worker_id: string;
          p_status: "completed" | "failed" | "skipped";
          p_error_code?: string | null;
          p_error_message?: string | null;
          p_retry?: boolean;
          p_available_at?: string | null;
        };
        Returns: Array<Database["public"]["Tables"]["memory_consolidation_jobs"]["Row"]>;
      };
      apply_memory_mutation_proposal: {
        Args: { p_profile_id: "profile-a" | "profile-b"; p_job_id: string; p_proposal_id: string; p_worker_id: string };
        Returns: Array<{
          status: "applied" | "conflict" | "rejected";
          proposal_id: string;
          item_id: string | null;
          item_revision: number | null;
          profile_global_revision: number | null;
          revision_id: string | null;
          source_id: string | null;
          reason: string | null;
        }>;
      };
      advance_thread_memory_revision_seen: {
        Args: { p_profile_id: "profile-a" | "profile-b"; p_thread_id: string; p_snapshot_revision: number };
        Returns: number;
      };
      enqueue_thread_compaction_job: {
        Args: { p_profile_id: "profile-a" | "profile-b"; p_thread_id: string; p_source_run_id: string; p_min_messages?: number; p_recent_tail_messages?: number };
        Returns: Array<Database["public"]["Tables"]["thread_compaction_jobs"]["Row"]>;
      };
      claim_thread_compaction_jobs: {
        Args: { p_worker_id: string; p_limit?: number; p_lease_seconds?: number };
        Returns: Array<Database["public"]["Tables"]["thread_compaction_jobs"]["Row"]>;
      };
      apply_thread_compaction_checkpoint: {
        Args: { p_profile_id: "profile-a" | "profile-b"; p_job_id: string; p_worker_id: string; p_continuity_summary: string; p_pinned_notes: string[]; p_checkpoint_message_id: string; p_checkpoint_created_at: string };
        Returns: string;
      };
      finish_thread_compaction_job: {
        Args: { p_profile_id: "profile-a" | "profile-b"; p_job_id: string; p_worker_id: string; p_status: "completed" | "failed" | "conflict" | "skipped"; p_error_code?: string | null; p_error_message?: string | null; p_retry?: boolean; p_available_at?: string | null };
        Returns: Array<Database["public"]["Tables"]["thread_compaction_jobs"]["Row"]>;
      };
    };
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
};
