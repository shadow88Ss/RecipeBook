# API Architecture

> **Superseded by `30_API.md`.** Retained as historical source material only. The original text mentioned GraphQL as an open option; `00_Master.md` §3.4 fixes REST-first with GraphQL out of scope for the initial implementation. Updated inline below.

Versioned **REST-first** service boundaries (not REST/GraphQL — GraphQL is not part of the initial implementation) with typed schemas, auth scopes, runtime validation, idempotency and consistent errors. See `30_API.md` for the full Phase 1 contract, including the explicit server-side Account→Profile authorization requirement.
