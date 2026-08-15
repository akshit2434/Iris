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
      memory_documents: {
        Row: {
          id: string;
          profile_id: "profile-a" | "profile-b";
          logical_key: string;
          content_markdown: string;
          document_revision: number;
          content_hash: string;
          created_at: string;
          updated_at: string;
          archived_at: string | null;
        };
        Insert: {
          id?: string;
          profile_id: "profile-a" | "profile-b";
          logical_key: string;
          content_markdown: string;
          document_revision?: number;
          content_hash: string;
          created_at?: string;
          updated_at?: string;
          archived_at?: string | null;
        };
        Update: Partial<{
          id: string;
          profile_id: "profile-a" | "profile-b";
          logical_key: string;
          content_markdown: string;
          document_revision: number;
          content_hash: string;
          created_at: string;
          updated_at: string;
          archived_at: string | null;
        }>;
        Relationships: [];
      };
      memory_document_revisions: {
        Row: {
          id: string;
          profile_id: "profile-a" | "profile-b";
          document_id: string;
          document_revision: number;
          profile_global_revision: number;
          content_markdown: string;
          content_hash: string;
          mutation_kind: "create" | "update" | "archive" | "restore" | "merge";
          idempotency_key: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          profile_id: "profile-a" | "profile-b";
          document_id: string;
          document_revision: number;
          profile_global_revision: number;
          content_markdown: string;
          content_hash: string;
          mutation_kind: "create" | "update" | "archive" | "restore" | "merge";
          idempotency_key?: string | null;
          created_at?: string;
        };
        Update: Partial<{
          id: string;
          profile_id: "profile-a" | "profile-b";
          document_id: string;
          document_revision: number;
          profile_global_revision: number;
          content_markdown: string;
          content_hash: string;
          mutation_kind: "create" | "update" | "archive" | "restore" | "merge";
          idempotency_key?: string | null;
          created_at: string;
        }>;
        Relationships: [];
      };
      memory_provenance: {
        Row: {
          id: string;
          profile_id: "profile-a" | "profile-b";
          document_id: string;
          document_revision_id: string;
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
          document_id: string;
          document_revision_id: string;
          source_kind: "message" | "thread" | "agent_event" | "manual" | "system";
          source_thread_id?: string | null;
          source_message_id?: string | null;
          source_agent_event_id?: string | null;
          source_agent_run_id?: string | null;
          source_excerpt?: string | null;
          metadata?: Json;
          created_at?: string;
        };
        Update: Partial<{
          id: string;
          profile_id: "profile-a" | "profile-b";
          document_id: string;
          document_revision_id: string;
          source_kind: "message" | "thread" | "agent_event" | "manual" | "system";
          source_thread_id: string | null;
          source_message_id: string | null;
          source_agent_event_id: string | null;
          source_agent_run_id: string | null;
          source_excerpt: string | null;
          metadata: Json;
          created_at: string;
        }>;
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
          logical_key: string;
          proposed_content_markdown: string;
          expected_document_revision: number | null;
          mutation_kind: "create" | "update" | "merge";
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
          logical_key: string;
          proposed_content_markdown: string;
          expected_document_revision?: number | null;
          mutation_kind: "create" | "update" | "merge";
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
          logical_key: string;
          proposed_content_markdown: string;
          expected_document_revision: number | null;
          mutation_kind: "create" | "update" | "merge";
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
      apply_memory_document_revision: {
        Args: {
          p_profile_id: "profile-a" | "profile-b";
          p_logical_key: string;
          p_content_markdown: string;
          p_mutation_kind: "create" | "update" | "archive" | "restore" | "merge";
          p_expected_document_revision?: number | null;
          p_source_kind?: "message" | "thread" | "agent_event" | "manual" | "system";
          p_source_thread_id?: string | null;
          p_source_message_id?: string | null;
          p_source_agent_event_id?: string | null;
          p_source_agent_run_id?: string | null;
          p_source_excerpt?: string | null;
          p_source_metadata?: Json;
          p_idempotency_key?: string | null;
        };
        Returns: Array<{
          profile_id: "profile-a" | "profile-b";
          document_id: string;
          document_revision: number;
          profile_global_revision: number;
          revision_id: string;
          provenance_id: string;
        }>;
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
          document_id: string | null;
          document_revision: number | null;
          profile_global_revision: number | null;
          revision_id: string | null;
          provenance_id: string | null;
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
