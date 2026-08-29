# Profile-scoped files

The `files` table stores metadata and provenance; bytes live in the private Supabase Storage bucket `iris-files`. Storage paths are generated as `<profile>/<file-id>/<safe-name>`, and all server reads first resolve the row with the active `profile_id`.

The upload API is the write boundary. Normal interactive chats may receive `file_list`, `file_search`, `file_read`, `file_open`, `artifact_list`, and `artifact_open`. Temporary chats do not receive these tools. Plain-text files can be read with a bounded limit; binary documents are available through short-lived signed URLs and are not claimed to be parsed.

Artifact creation and document/PDF parsing remain a later phase. This boundary is intentionally ready for those capabilities without allowing the model to write arbitrary files.
