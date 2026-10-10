import { Router, type Request, type Response, type NextFunction } from 'express';
import { pathValidator } from '../utils/pathValidator.js';
import { ARCHITECTURE_FIELDS, ARCHITECTURE_FILE, type ArchitectureField } from './document.js';
import { ArchitectureConflict, ArchitectureStore } from './store.js';
import { updateArchitectureField } from './fieldMutation.js';

/** Mounted below /api/terminal, after its existing auth, CSRF and encrypted transport. */
export function architectureRoutes(): Router {
  const router = Router();
  router.use(async (req, res, next) => {
    try {
      const requested = req.method === 'GET' ? req.query.root : req.body?.root;
      if (typeof requested !== 'string') { res.status(400).json({ error: 'Project root is required' }); return; }
      const root = await (req.pathValidator ?? pathValidator).validateAsync(requested);
      res.locals.architectureStore = new ArchitectureStore(root); next();
    } catch (error) { res.status(403).json({ error: error instanceof Error ? error.message : 'Project cannot be accessed' }); }
  });
  const store = (res: Response) => res.locals.architectureStore as ArchitectureStore;
  router.get('/documents', async (_req, res, next) => { try { res.json({ files: await store(res).list() }); } catch (error) { next(error); } });
  router.get('/document', async (req, res, next) => { try { res.json(await store(res).read(typeof req.query.file === 'string' ? req.query.file : ARCHITECTURE_FILE)); } catch (error) { next(error); } });
  router.put('/document', async (req, res, next) => { try { res.json(await store(res).save(req.body.file ?? ARCHITECTURE_FILE, req.body.document, req.body.revision)); } catch (error) { next(error); } });
  router.get('/history', async (req, res, next) => { try { res.json({ versions: await store(res).history(String(req.query.file ?? ARCHITECTURE_FILE)) }); } catch (error) { next(error); } });
  router.get('/version', async (req, res, next) => { try { res.json({ document: await store(res).historical(String(req.query.file), String(req.query.id)) }); } catch (error) { next(error); } });
  router.get('/bundle', async (req, res, next) => { try {
    const file = String(req.query.file ?? ARCHITECTURE_FILE), storage = store(res);
    const loaded = await storage.read(file);
    if (!loaded.document) { res.status(404).json({ error: 'Architecture document not found' }); return; }
    res.json(file === '.omm' ? await storage.exportOmmBundle() : await storage.exportOmmBundle(loaded.document));
  } catch (error) { next(error); } });
  router.put('/bundle', async (req, res, next) => { try { await store(res).importOmmBundle(req.body.bundle, req.body.revision); res.json(await store(res).read('.omm')); } catch (error) { next(error); } });
  router.put('/field', async (req, res, next) => {
    try {
      const { file = ARCHITECTURE_FILE, perspective, node, field, value, revision } = req.body;
      if (!ARCHITECTURE_FIELDS.includes(field) || typeof value !== 'string' || value.length > 100_000) { res.status(400).json({ error: 'Invalid architecture field' }); return; }
      const storage = store(res);
      if (file === '.omm') {
        const loaded = await storage.read('.omm'), view = loaded.document?.perspectives.find(view => view.id === perspective);
        const target = node ? view?.nodes.find(item => item.id === node) : view;
        if (!view || !target) { res.status(404).json({ error: 'Architecture element not found' }); return; }
        // Resolve opaque viewer IDs back to .omm paths through the store's stable IDs.
        const { createHash } = await import('node:crypto');
        const element = node ? ('documentPath' in target && typeof target.documentPath === 'string' && target.documentPath.startsWith(`${view.id}/`) && `e_${createHash('sha256').update(target.documentPath).digest('hex').slice(0, 20)}` === node ? target.documentPath : undefined) : view.id;
        if (!element) { res.status(404).json({ error: 'Architecture element has no document yet' }); return; }
        res.json(await storage.writeOmmField(element, field as ArchitectureField, value, revision)); return;
      }
      const loaded = await storage.read(file);
      if (!loaded.document) { res.status(404).json({ error: 'Architecture document not found' }); return; }
      const document = updateArchitectureField(loaded.document, perspective, node, field, value);
      res.json(await storage.save(file, document, revision));
    } catch (error) { next(error); }
  });
  router.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    res.status(error instanceof ArchitectureConflict ? 409 : 400).json({ error: error instanceof Error ? error.message : 'Architecture operation failed' });
  });
  return router;
}
