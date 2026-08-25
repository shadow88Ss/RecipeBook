# System Architecture

> **Superseded.** The runtime/stack choices below are fixed by `00_Master.md` §3. This document is retained as historical source material only; where it conflicts with `00_Master.md`, the Master controls. Updated inline below to remove stale open-choice wording.

## Logical Layers
1. Mobile Apps — iOS and Android.
2. Authentication and Account Layer.
3. Profile and Household Layer.
4. Multimodal Input Layer.
5. Content Ingestion Layer.
6. Claude AI Orchestration Layer.
7. Universal Food Intelligence Layer.
8. Deterministic Nutrition Calculation Layer.
9. Recipe Library.
10. Wearable Integration Layer.
11. Coaching and Planning Layer.
12. Analytics Layer.
13. Security, Consent and Audit Layer.

## Fixed Runtime (per `00_Master.md` §3 — not an open choice)
- Mobile: **React Native + Expo + TypeScript** (not Flutter).
- Backend: **TypeScript-first**, on Supabase server-side functions/services and background workers (not a separate Python/FastAPI backend).
- Data: **PostgreSQL** via Supabase.
- Object storage: Supabase Storage for source images/raw imported artifacts as required.
- AI: Claude API, accessed server-side only.
- Queue: durable **PostgreSQL/Supabase-compatible job queue** for asynchronous import/sync jobs (not Redis, initially).
- Cache: food search, recipe search and device sync acceleration — mechanism deferred until a measured operational need justifies introducing one; not assumed to be Redis.

## Key Boundary
Claude may interpret, classify, rank, estimate and explain.
Claude must not be the authoritative source for nutrient values or arithmetic when structured data is available.
