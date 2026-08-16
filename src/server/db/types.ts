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
          estimated_tokens: number | null;
          tokenizer_provider: string | null;
          tokenizer_model: string | null;
          tokenizer_version: string | null;
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
          estimated_tokens?: number | null;
          tokenizer_provider?: string | null;
          tokenizer_model?: string | null;
          tokenizer_version?: string | null;
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
          estimated_tokens: number | null;
          tokenizer_provider: string | null;
          tokenizer_model: string | null;
          tokenizer_version: string | null;
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
          estimated_input_tokens: number | null;
          actual_input_tokens: number | null;
          actual_output_tokens: number | null;
          actual_total_tokens: number | null;
          context_token_ledger: Json;
          usage_metadata: Json;
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
          estimated_input_tokens?: number | null;
          actual_input_tokens?: number | null;
          actual_output_tokens?: number | null;
          actual_total_tokens?: number | null;
          context_token_ledger?: Json;
          usage_metadata?: Json;
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
          estimated_input_tokens: number | null;
          actual_input_tokens: number | null;
          actual_output_tokens: number | null;
          actual_total_tokens: number | null;
          context_token_ledger: Json;
          usage_metadata: Json;
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
          memory_revision_seen: number;
          active_continuity_checkpoint_id: string | null;
          continuity_revision: number;
          updated_at: string;
        };
        Insert: {
          thread_id: string;
          profile_id: "profile-a" | "profile-b";
          memory_revision_seen?: number;
          active_continuity_checkpoint_id?: string | null;
          continuity_revision?: number;
          updated_at?: string;
        };
        Update: Partial<{
          thread_id: string;
          profile_id: "profile-a" | "profile-b";
          memory_revision_seen: number;
          active_continuity_checkpoint_id: string | null;
          continuity_revision: number;
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
      profile_memory_settings: {
        Row: {
          profile_id: "profile-a" | "profile-b";
          saved_memory_enabled: boolean;
          reference_history_enabled: boolean;
          updated_at: string;
        };
        Insert: {
          profile_id: "profile-a" | "profile-b";
          saved_memory_enabled?: boolean;
          reference_history_enabled?: boolean;
          updated_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["profile_memory_settings"]["Insert"]>;
        Relationships: [];
      };
      profile_reference_history_state: {
        Row: {
          profile_id: "profile-a" | "profile-b";
          last_enqueued_token_watermark: number;
          last_processed_token_watermark: number;
          last_enqueued_at: string | null;
          last_source_at: string | null;
          active_snapshot_id: string | null;
          active_snapshot_revision: number;
          updated_at: string;
        };
        Insert: {
          profile_id: "profile-a" | "profile-b";
          last_enqueued_token_watermark?: number;
          last_processed_token_watermark?: number;
          last_enqueued_at?: string | null;
          last_source_at?: string | null;
          active_snapshot_id?: string | null;
          active_snapshot_revision?: number;
          updated_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["profile_reference_history_state"]["Insert"]>;
        Relationships: [];
      };
      profile_reference_history_snapshots: {
        Row: {
          id: string;
          profile_id: "profile-a" | "profile-b";
          revision: number;
          status: "active" | "superseded" | "invalidated";
          document: Json;
          rendered_text: string;
          source_ranges: Json;
          covered_token_watermark: number;
          covered_through_at: string | null;
          source_hash: string;
          memory_revision: number;
          model: string;
          synthesizer_version: string;
          previous_snapshot_id: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          profile_id: "profile-a" | "profile-b";
          revision: number;
          status?: "active" | "superseded" | "invalidated";
          document: Json;
          rendered_text: string;
          source_ranges?: Json;
          covered_token_watermark: number;
          covered_through_at?: string | null;
          source_hash: string;
          memory_revision?: number;
          model: string;
          synthesizer_version: string;
          previous_snapshot_id?: string | null;
          created_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["profile_reference_history_snapshots"]["Insert"]>;
        Relationships: [];
      };
      reference_history_jobs: {
        Row: {
          id: string;
          profile_id: "profile-a" | "profile-b";
          source_run_id: string | null;
          status: "pending" | "running" | "completed" | "failed" | "conflict" | "skipped";
          attempts: number;
          idempotency_key: string;
          expected_snapshot_id: string | null;
          expected_snapshot_revision: number;
          source_start_token_watermark: number;
          source_end_token_watermark: number;
          rebuild_from_raw: boolean;
          idle_signal: boolean;
          model: string;
          synthesizer_version: string;
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
          source_run_id?: string | null;
          status?: "pending" | "running" | "completed" | "failed" | "conflict" | "skipped";
          attempts?: number;
          idempotency_key: string;
          expected_snapshot_id?: string | null;
          expected_snapshot_revision?: number;
          source_start_token_watermark?: number;
          source_end_token_watermark: number;
          rebuild_from_raw?: boolean;
          idle_signal?: boolean;
          model: string;
          synthesizer_version: string;
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
        Update: Partial<Database["public"]["Tables"]["reference_history_jobs"]["Insert"]>;
        Relationships: [];
      };
      memory_consolidation_jobs: {
        Row: {
          id: string;
          profile_id: "profile-a" | "profile-b";
          thread_id: string;
          source_run_id: string;
          source_token_total: number;
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
          source_token_total?: number;
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
          source_token_total: number;
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
      thread_continuity_checkpoints: {
        Row: {
          id: string;
          profile_id: "profile-a" | "profile-b";
          thread_id: string;
          revision: number;
          document: Json;
          rendered_text: string;
          covered_through_ordinal: number;
          covered_through_message_id: string;
          covered_through_created_at: string;
          source_start_message_id: string;
          source_end_message_id: string;
          source_message_ids: string[];
          source_estimated_tokens: number;
          rendered_tokens: number;
          model: string;
          tokenizer_provider: string;
          tokenizer_version: string;
          summarizer_version: string;
          previous_checkpoint_id: string | null;
          input_hash: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          profile_id: "profile-a" | "profile-b";
          thread_id: string;
          revision: number;
          document: Json;
          rendered_text: string;
          covered_through_ordinal: number;
          covered_through_message_id: string;
          covered_through_created_at: string;
          source_start_message_id: string;
          source_end_message_id: string;
          source_message_ids: string[];
          source_estimated_tokens: number;
          rendered_tokens: number;
          model: string;
          tokenizer_provider: string;
          tokenizer_version: string;
          summarizer_version: string;
          previous_checkpoint_id?: string | null;
          input_hash: string;
        };
        Update: Partial<Database["public"]["Tables"]["thread_continuity_checkpoints"]["Insert"]>;
        Relationships: [];
      };
      thread_continuity_jobs: {
        Row: {
          id: string;
          profile_id: "profile-a" | "profile-b";
          thread_id: string;
          source_run_id: string;
          status: "pending" | "running" | "completed" | "failed" | "conflict" | "skipped";
          attempts: number;
          idempotency_key: string;
          expected_checkpoint_id: string | null;
          expected_continuity_revision: number;
          source_start_message_id: string;
          source_end_message_id: string;
          source_start_ordinal: number;
          source_end_ordinal: number;
          source_estimated_tokens: number;
          projected_input_tokens: number;
          safe_input_budget_tokens: number;
          input_hash: string;
          model: string;
          tokenizer_provider: string;
          tokenizer_version: string;
          rebuild_from_raw: boolean;
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
          expected_checkpoint_id?: string | null;
          expected_continuity_revision?: number;
          source_start_message_id: string;
          source_end_message_id: string;
          source_start_ordinal: number;
          source_end_ordinal: number;
          source_estimated_tokens: number;
          projected_input_tokens: number;
          safe_input_budget_tokens: number;
          input_hash: string;
          model: string;
          tokenizer_provider: string;
          tokenizer_version: string;
          rebuild_from_raw?: boolean;
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
        Update: Partial<Database["public"]["Tables"]["thread_continuity_jobs"]["Insert"]>;
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
      search_messages_v2: {
        Args: {
          p_profile_id: "profile-a" | "profile-b";
          p_query?: string;
          p_exact_phrase?: string | null;
          p_match_type?: "exact_phrase" | "hybrid" | "semantic";
          p_roles?: string[] | null;
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
          match_type: "exact_phrase" | "hybrid" | "semantic";
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
      enqueue_reference_history_job: {
        Args: {
          p_profile_id: "profile-a" | "profile-b";
          p_source_run_id?: string | null;
          p_source_token_total?: number | null;
          p_idle_signal?: boolean;
          p_rebuild_from_raw?: boolean;
          p_model?: string;
          p_synthesizer_version?: string;
          p_debounce_seconds?: number;
        };
        Returns: Array<Database["public"]["Tables"]["reference_history_jobs"]["Row"]>;
      };
      claim_reference_history_jobs: {
        Args: { p_worker_id: string; p_limit?: number; p_lease_seconds?: number };
        Returns: Array<Database["public"]["Tables"]["reference_history_jobs"]["Row"]>;
      };
      apply_reference_history_snapshot: {
        Args: {
          p_profile_id: "profile-a" | "profile-b";
          p_job_id: string;
          p_worker_id: string;
          p_expected_snapshot_id: string | null;
          p_expected_snapshot_revision: number;
          p_document: Json;
          p_rendered_text: string;
          p_source_ranges: Json;
          p_covered_token_watermark: number;
          p_covered_through_at: string | null;
          p_source_hash: string;
          p_memory_revision: number;
          p_model: string;
          p_synthesizer_version: string;
          p_previous_snapshot_id: string | null;
        };
        Returns: string;
      };
      finish_reference_history_job: {
        Args: { p_profile_id: "profile-a" | "profile-b"; p_job_id: string; p_worker_id: string; p_status: "completed" | "failed" | "conflict" | "skipped"; p_error_code?: string | null; p_error_message?: string | null; p_retry?: boolean; p_available_at?: string | null };
        Returns: Array<Database["public"]["Tables"]["reference_history_jobs"]["Row"]>;
      };
      invalidate_reference_history_snapshot: {
        Args: { p_profile_id: "profile-a" | "profile-b"; p_reason?: string };
        Returns: undefined;
      };
      enqueue_memory_consolidation_job: {
        Args: { p_profile_id: "profile-a" | "profile-b"; p_thread_id: string; p_source_run_id: string; p_source_token_total?: number; p_idle_signal?: boolean; p_debounce_seconds?: number };
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
      enqueue_thread_continuity_job: {
        Args: {
          p_profile_id: "profile-a" | "profile-b";
          p_thread_id: string;
          p_source_run_id: string;
          p_source_start_message_id: string;
          p_source_end_message_id: string;
          p_source_start_ordinal: number;
          p_source_end_ordinal: number;
          p_source_estimated_tokens: number;
          p_projected_input_tokens: number;
          p_safe_input_budget_tokens: number;
          p_input_hash: string;
          p_model: string;
          p_tokenizer_provider: string;
          p_tokenizer_version: string;
          p_rebuild_from_raw?: boolean;
        };
        Returns: Array<Database["public"]["Tables"]["thread_continuity_jobs"]["Row"]>;
      };
      claim_thread_continuity_jobs: {
        Args: { p_worker_id: string; p_limit?: number; p_lease_seconds?: number };
        Returns: Array<Database["public"]["Tables"]["thread_continuity_jobs"]["Row"]>;
      };
      apply_thread_continuity_checkpoint: {
        Args: {
          p_profile_id: "profile-a" | "profile-b";
          p_job_id: string;
          p_worker_id: string;
          p_expected_checkpoint_id: string | null;
          p_expected_continuity_revision: number;
          p_document: Json;
          p_rendered_text: string;
          p_covered_through_ordinal: number;
          p_covered_through_message_id: string;
          p_covered_through_created_at: string;
          p_source_start_message_id: string;
          p_source_end_message_id: string;
          p_source_message_ids: string[];
          p_source_estimated_tokens: number;
          p_rendered_tokens: number;
          p_model: string;
          p_tokenizer_provider: string;
          p_tokenizer_version: string;
          p_summarizer_version: string;
          p_previous_checkpoint_id: string | null;
          p_input_hash: string;
        };
        Returns: string;
      };
      invalidate_thread_continuity_checkpoint: {
        Args: { p_profile_id: "profile-a" | "profile-b"; p_thread_id: string; p_reason: string };
        Returns: undefined;
      };
      finish_thread_continuity_job: {
        Args: { p_profile_id: "profile-a" | "profile-b"; p_job_id: string; p_worker_id: string; p_status: "completed" | "failed" | "conflict" | "skipped"; p_error_code?: string | null; p_error_message?: string | null; p_retry?: boolean; p_available_at?: string | null };
        Returns: Array<Database["public"]["Tables"]["thread_continuity_jobs"]["Row"]>;
      };
      clear_reference_history_data: {
        Args: { p_profile_id: "profile-a" | "profile-b" };
        Returns: undefined;
      };
    };
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
};
