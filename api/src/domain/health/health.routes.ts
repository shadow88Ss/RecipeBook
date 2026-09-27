// Layer 4A §13 — minimal operational endpoint. Liveness only: no database
// or upstream dependency is queried, and nothing about configuration,
// connection strings, or environment variables is ever included in the
// response (spec §13).

import { Router } from 'express';

export function createHealthRouter(): Router {
  const router = Router();

  router.get('/', (_req, res) => {
    res.status(200).json({
      status: 'ok',
      uptimeSeconds: Math.round(process.uptime()),
    });
  });

  return router;
}
