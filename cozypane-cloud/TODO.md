# Future Work

## Deploy Feature Roadmap

- **Rollback to previous deployment** — keep previous container images, allow instant rollback
- **Auto-scaling** — scale containers based on load
- **GitOps (push-to-deploy)** — deploy automatically on git push
- **Multiple database types (MySQL, Redis)** — support beyond PostgreSQL

## Already Shipped (for reference, removed from TODO)

- Custom domains — shipped via direct API + desktop IPC (`deploy:addDomain`, `deploy:verifyDomain`, etc.) and the Deploy panel UI. Not yet exposed as an MCP tool; that wrapper remains future work.
- Streaming build logs — shipped via WebSocket `/deploy/:id/logs/stream` (plus `/deploy/:id/exec` for interactive shells).
