# Artifacts boundary

Generated artifacts use the profile-scoped `files` metadata table and private `iris-files` bucket. `artifact_list` and `artifact_open` are available to normal chats, while artifact creation and document/PDF generation remain deferred until a bounded generation runtime exists.
