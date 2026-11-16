/**
 * Mock AI gateway.
 *
 *   GET  /ai/tools                 the catalogue, with each tool's enabled state
 *   POST /ai/run                   { toolId, input, entityType?, entityId? } → a draft AiRun
 *   POST /ai/runs/:id/regenerate   re-runs the same tool and input as a new draft
 *   POST /ai/runs/:id/review       { action: approve | reject | edit, editedOutput?, note? }
 *
 * Every run is stored in `aiRuns` with status `draft` and must be reviewed by a person before
 * it counts for anything. Generation, approval, rejection and edits are written to the audit
 * log (requirements §5.16, §5.18).
 *
 * The engines are rule-based stand-ins for a model. Replacing them with a real model is a
 * change inside `run()` only: this contract, the review flow and the audit trail do not move.
 */

const crypto = require('crypto');
const registry = require('./registry');
const helpers = require('./helpers');
const { route } = require('./router');

const LIMITATION_DEFAULT =
  'Rule-based mock AI — review the source data before acting on this result.';

/** Actions HR can take on a run, and the audit action each one writes. */
const REVIEW_ACTIONS = {
  approve: { status: 'approved', audit: 'ai.approve' },
  reject: { status: 'rejected', audit: 'ai.reject' },
  edit: { status: 'draft', audit: 'ai.edit' },
};

function newId(prefix) {
  return `${prefix}_${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;
}

/**
 * Read-only view of the database for engines.
 *
 * Confidential documents are hidden unless settings allow AI to see them, so the privacy rule
 * is enforced in one place rather than in twenty engines.
 */
function createDbView(db, settings) {
  const allowConfidential = Boolean(settings.ai && settings.ai.allowConfidentialDocuments);

  const get = (name) => {
    const rows = db.get(name).value() || [];
    const copy = JSON.parse(JSON.stringify(rows));
    if (name === 'documents' && !allowConfidential) {
      return copy.filter((document) => !document.confidential);
    }
    return copy;
  };

  return {
    get,
    byId: (name, id) => (id ? get(name).find((row) => row.id === id) || null : null),
    allowConfidential,
  };
}

function settingsOf(db) {
  return db.get('settings').value() || {};
}

/** A tool is runnable when AI is on globally and the feature is not switched off. */
function toolEnabled(settings, toolId) {
  if (!settings.ai || settings.ai.enabled === false) return { ok: false, reason: 'AI is disabled in settings' };
  const features = settings.ai.features || {};
  const key = registry.featureKey(toolId);
  if (key in features && features[key] === false) {
    return { ok: false, reason: `The ${toolId} feature is switched off in AI settings` };
  }
  return { ok: true };
}

function createAiRoutes(router) {
  const db = router.db;

  /** Runs an engine and builds the stored AiRun. */
  function execute({ toolId, input, meta, user, settings }) {
    const engine = registry.get(toolId);
    if (!engine) throw Object.assign(new Error(`Unknown AI tool: ${toolId}`), { status: 404 });

    const enabled = toolEnabled(settings, toolId);
    if (!enabled.ok) throw Object.assign(new Error(enabled.reason), { status: 403 });

    const view = createDbView(db, settings);
    const now = new Date();

    // `tools` lets the assistant describe what it can do without importing the registry.
    const result = engine.run({ input: input || {}, db: view, settings, now, helpers, tools: registry.list() });

    if (!result || typeof result.output !== 'string') {
      throw Object.assign(new Error(`Engine ${toolId} returned no output`), { status: 500 });
    }
    // Enforced centrally: an unsourced result is not reviewable, so it is not returned.
    if (!Array.isArray(result.sources) || !result.sources.length) {
      throw Object.assign(new Error(`Engine ${toolId} returned no source reference`), { status: 500 });
    }

    const logPrompts = !settings.ai || settings.ai.logPrompts !== false;
    const prompt = engine.prompt ? engine.prompt(input || {}) : toolId;

    return {
      id: newId('air'),
      toolId,
      module: engine.module,
      entityType: meta.entityType || null,
      entityId: meta.entityId || null,
      prompt: logPrompts ? prompt : null,
      input: logPrompts ? input || {} : null,
      output: result.output,
      editedOutput: null,
      sources: result.sources,
      confidence: Math.max(0, Math.min(1, Number(result.confidence) || 0.5)),
      limitation: result.limitation ? `${result.limitation} (${LIMITATION_DEFAULT})` : LIMITATION_DEFAULT,
      data: result.data || null,
      /** Entities the engine resolved, carried into the next turn of a conversation. */
      resolvedContext: result.context || null,
      conversationId: meta.conversationId || null,
      routing: meta.routing || null,
      status: 'draft',
      reviewedBy: null,
      reviewedAt: null,
      reviewNote: null,
      lastAction: 'generate',
      previousRunId: meta.previousRunId || null,
      createdBy: user ? user.id : null,
      createdAt: now.toISOString(),
    };
  }

  function save(run, req, auditAction, extra) {
    db.get('aiRuns').push(run).value();

    db.get('auditLogs')
      .push({
        id: newId('aud'),
        action: auditAction,
        entity: 'aiRun',
        entityId: run.id,
        entityLabel: run.toolId,
        userId: req.auditUser ? req.auditUser.id : null,
        userEmail: req.auditUser ? req.auditUser.email : null,
        oldValue: (extra && extra.oldValue) || null,
        newValue: (extra && extra.newValue) || { toolId: run.toolId, confidence: run.confidence, status: run.status },
        aiRunId: run.id,
        details: { module: run.module, sources: run.sources.length },
        ip: req.ip,
        userAgent: req.get('user-agent') || null,
        createdAt: new Date().toISOString(),
      })
      .value();

    if (typeof req.scheduleDbWrite === 'function') req.scheduleDbWrite();
    else db.write();
  }

  return (req, res, next) => {
    if (!req.path.startsWith('/ai/')) return next();

    const settings = settingsOf(db);

    // GET /ai/tools
    if (req.method === 'GET' && req.path === '/ai/tools') {
      return res.jsonp(
        registry.list().map((tool) => ({
          ...tool,
          enabled: toolEnabled(settings, tool.id).ok,
        })),
      );
    }

    // POST /ai/run
    if (req.method === 'POST' && req.path === '/ai/run') {
      const body = req.body || {};
      if (!body.toolId) return res.status(400).jsonp({ message: 'toolId is required' });

      try {
        const run = execute({
          toolId: body.toolId,
          input: body.input,
          meta: { entityType: body.entityType, entityId: body.entityId },
          user: req.auditUser,
          settings,
        });
        save(run, req, 'ai.generate');
        return res.status(201).jsonp(run);
      } catch (error) {
        return res.status(error.status || 500).jsonp({ message: error.message, toolId: body.toolId });
      }
    }

    // POST /ai/chat — the assistant. One box, any question: the router picks the tool.
    if (req.method === 'POST' && req.path === '/ai/chat') {
      const body = req.body || {};
      const message = String(body.message || '').trim();
      if (!message) return res.status(400).jsonp({ message: 'message is required' });

      if (!settings.ai || settings.ai.enabled === false) {
        return res.status(403).jsonp({ message: 'AI is disabled in settings' });
      }

      const now = new Date();
      const view = createDbView(db, settings);

      // Conversations carry resolved entities forward, so "what about her leave balance?"
      // still knows who "her" is.
      let conversation = body.conversationId
        ? db.get('aiConversations').find({ id: body.conversationId }).value()
        : null;

      if (!conversation) {
        conversation = {
          id: newId('cnv'),
          title: message.length > 60 ? `${message.slice(0, 57)}…` : message,
          context: {},
          messages: [],
          createdBy: req.auditUser ? req.auditUser.id : null,
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
        };
        db.get('aiConversations').push(conversation).value();
      }

      const routing = route({
        message,
        db: view,
        now,
        context: conversation.context || {},
        extra: { text: body.text || '' },
      });

      // A tool the user switched off should not be reached through the chat either.
      const chosen = toolEnabled(settings, routing.toolId).ok
        ? routing.toolId
        : 'hr-data-query';

      let run;
      let replyText;
      try {
        run = execute({
          toolId: chosen,
          input: chosen === routing.toolId ? routing.input : { question: message },
          meta: {
            entityType: body.entityType || null,
            entityId: body.entityId || null,
            conversationId: conversation.id,
            routing: { toolId: chosen, score: routing.score, reason: routing.reason, alternatives: routing.alternatives },
          },
          user: req.auditUser,
          settings,
        });
        replyText = run.output;
      } catch (error) {
        // A routing mistake should answer, not fail: fall back to the general engine.
        if (chosen !== 'hr-data-query') {
          run = execute({
            toolId: 'hr-data-query',
            input: { question: message },
            meta: {
              conversationId: conversation.id,
              routing: { toolId: 'hr-data-query', fallbackFrom: chosen, error: error.message },
            },
            user: req.auditUser,
            settings,
          });
          replyText = `${run.output}\n\n(I first tried ${chosen} but could not run it: ${error.message})`;
        } else {
          return res.status(error.status || 500).jsonp({ message: error.message });
        }
      }

      save(run, req, 'ai.chat');

      const userMessage = {
        id: newId('msg'),
        role: 'user',
        content: message,
        createdAt: now.toISOString(),
      };
      const assistantMessage = {
        id: newId('msg'),
        role: 'assistant',
        content: replyText,
        aiRunId: run.id,
        toolId: run.toolId,
        sources: run.sources,
        confidence: run.confidence,
        limitation: run.limitation,
        status: run.status,
        createdAt: new Date().toISOString(),
      };

      const nextContext = {
        ...(conversation.context || {}),
        ...(routing.entities || {}),
        ...(run.resolvedContext || {}),
      };
      // Only ids are carried forward; free-text fragments would leak between questions.
      for (const key of Object.keys(nextContext)) {
        if (!/Id$|^month$|^days$|^months$/.test(key)) delete nextContext[key];
      }

      db.get('aiConversations')
        .find({ id: conversation.id })
        .assign({
          context: nextContext,
          messages: [...conversation.messages, userMessage, assistantMessage],
          updatedAt: new Date().toISOString(),
        })
        .value();

      if (typeof req.scheduleDbWrite === 'function') req.scheduleDbWrite();
      else db.write();

      return res.status(201).jsonp({
        conversationId: conversation.id,
        message: assistantMessage,
        run,
        routing: {
          toolId: run.toolId,
          reason: routing.reason,
          alternatives: routing.alternatives,
          blocked: routing.blocked,
          entities: routing.entities,
        },
      });
    }

    // POST /ai/runs/:id/regenerate
    const regenerate = req.path.match(/^\/ai\/runs\/([^/]+)\/regenerate$/);
    if (req.method === 'POST' && regenerate) {
      const previous = db.get('aiRuns').find({ id: regenerate[1] }).value();
      if (!previous) return res.status(404).jsonp({ message: 'AI run not found' });

      try {
        const run = execute({
          toolId: previous.toolId,
          input: (req.body && req.body.input) || previous.input || {},
          meta: { entityType: previous.entityType, entityId: previous.entityId, previousRunId: previous.id },
          user: req.auditUser,
          settings,
        });

        db.get('aiRuns').find({ id: previous.id }).assign({ lastAction: 'regenerate' }).value();
        save(run, req, 'ai.regenerate', { oldValue: { runId: previous.id }, newValue: { runId: run.id } });
        return res.status(201).jsonp(run);
      } catch (error) {
        return res.status(error.status || 500).jsonp({ message: error.message, toolId: previous.toolId });
      }
    }

    // POST /ai/runs/:id/review
    const review = req.path.match(/^\/ai\/runs\/([^/]+)\/review$/);
    if (req.method === 'POST' && review) {
      const run = db.get('aiRuns').find({ id: review[1] }).value();
      if (!run) return res.status(404).jsonp({ message: 'AI run not found' });

      const body = req.body || {};
      const action = REVIEW_ACTIONS[body.action];
      if (!action) {
        return res.status(400).jsonp({ message: `action must be one of: ${Object.keys(REVIEW_ACTIONS).join(', ')}` });
      }
      if (body.action === 'edit' && typeof body.editedOutput !== 'string') {
        return res.status(400).jsonp({ message: 'editedOutput is required when action is "edit"' });
      }
      if (!req.auditUser) {
        // A review has to be attributable, or the audit trail is worthless.
        return res.status(401).jsonp({ message: 'Sign in before reviewing an AI result' });
      }

      // lowdb hands back a live reference, so the previous status has to be copied before
      // `assign` overwrites it — otherwise the audit entry records the new value as the old one.
      const previousStatus = run.status;
      const previousAction = run.lastAction;

      const now = new Date().toISOString();
      const changes = {
        status: action.status,
        reviewedBy: req.auditUser.id,
        reviewedAt: now,
        reviewNote: body.note || null,
        lastAction: body.action,
        editedOutput: body.action === 'edit' ? body.editedOutput : run.editedOutput,
      };

      db.get('aiRuns').find({ id: run.id }).assign(changes).value();

      db.get('auditLogs')
        .push({
          id: newId('aud'),
          action: action.audit,
          entity: 'aiRun',
          entityId: run.id,
          entityLabel: run.toolId,
          userId: req.auditUser.id,
          userEmail: req.auditUser.email,
          oldValue: { status: previousStatus, lastAction: previousAction },
          newValue: { status: changes.status, lastAction: changes.lastAction, note: changes.reviewNote },
          aiRunId: run.id,
          details: { module: run.module },
          ip: req.ip,
          userAgent: req.get('user-agent') || null,
          createdAt: now,
        })
        .value();

      if (typeof req.scheduleDbWrite === 'function') req.scheduleDbWrite();
      else db.write();

      return res.jsonp({ ...run, ...changes });
    }

    return res.status(404).jsonp({ message: `Unknown AI endpoint: ${req.method} ${req.path}` });
  };
}

module.exports = { createAiRoutes, LIMITATION_DEFAULT };
