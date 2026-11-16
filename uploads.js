/**
 * File uploads for the mock API.
 *
 *   POST   /uploads          multipart form, field `file` (+ optional category, employeeId, title)
 *   GET    /uploads/:name    serves a stored file
 *   GET    /uploads          lists what is stored
 *   DELETE /uploads/:name    removes one file
 *
 * Stored names are generated (random id + an extension derived from the detected MIME type),
 * never taken from the uploaded file name, so a crafted name cannot escape the upload folder.
 * The original name is returned in the response for display.
 *
 * Local development only: there is no virus scanning and no access control on the files.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const multer = require('multer');

const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, 'uploads');
const MAX_BYTES = Number(process.env.UPLOAD_MAX_BYTES || 20 * 1024 * 1024);

/** Accepted types, mapped to the extension the stored file gets. */
const ALLOWED_TYPES = {
  'application/pdf': 'pdf',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'text/csv': 'csv',
  'text/plain': 'txt',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
};

/** Only names this generator could have produced are accepted back from the client. */
const STORED_NAME = /^[a-f0-9]{24}\.[a-z0-9]{3,4}$/;

function ensureDir() {
  if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, done) => {
    ensureDir();
    done(null, UPLOAD_DIR);
  },
  filename: (req, file, done) => {
    const extension = ALLOWED_TYPES[file.mimetype] || 'bin';
    done(null, `${crypto.randomBytes(12).toString('hex')}.${extension}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_BYTES, files: 1, fields: 10 },
  fileFilter: (req, file, done) => {
    if (ALLOWED_TYPES[file.mimetype]) return done(null, true);
    const error = new Error(`Unsupported file type: ${file.mimetype}`);
    error.code = 'UNSUPPORTED_FILE_TYPE';
    done(error);
  },
});

function publicUrl(req, fileName) {
  const host = req.get('host');
  return `${req.protocol}://${host}/uploads/${fileName}`;
}

/**
 * Express middleware with the upload endpoints. Mount before the json-server router.
 * `router` is the json-server router, used to record the upload in the audit log.
 */
function createUploadRoutes(router) {
  const handler = upload.single('file');

  return (req, res, next) => {
    if (!req.path.startsWith('/uploads')) return next();

    const name = req.path.replace(/^\/uploads\/?/, '');

    if (req.method === 'GET' && name) {
      if (!STORED_NAME.test(name)) return res.status(400).jsonp({ message: 'Invalid file name' });
      const filePath = path.join(UPLOAD_DIR, name);
      if (!fs.existsSync(filePath)) return res.status(404).jsonp({ message: 'File not found' });
      return res.sendFile(filePath);
    }

    if (req.method === 'GET') {
      ensureDir();
      const files = fs.readdirSync(UPLOAD_DIR).map((fileName) => {
        const stat = fs.statSync(path.join(UPLOAD_DIR, fileName));
        return {
          fileName,
          url: publicUrl(req, fileName),
          sizeBytes: stat.size,
          uploadedAt: stat.mtime.toISOString(),
        };
      });
      return res.jsonp(files);
    }

    if (req.method === 'DELETE' && name) {
      if (!STORED_NAME.test(name)) return res.status(400).jsonp({ message: 'Invalid file name' });
      const filePath = path.join(UPLOAD_DIR, name);
      if (!fs.existsSync(filePath)) return res.status(404).jsonp({ message: 'File not found' });
      fs.unlinkSync(filePath);
      return res.status(204).end();
    }

    if (req.method !== 'POST') return res.status(405).jsonp({ message: 'Method not allowed' });

    return handler(req, res, (error) => {
      if (error) {
        const status = error.code === 'LIMIT_FILE_SIZE' || error.code === 'UNSUPPORTED_FILE_TYPE' ? 400 : 500;
        return res.status(status).jsonp({
          message:
            error.code === 'LIMIT_FILE_SIZE'
              ? `File is larger than the ${Math.round(MAX_BYTES / 1048576)} MB limit`
              : error.message,
          code: error.code || 'UPLOAD_FAILED',
        });
      }
      if (!req.file) return res.status(400).jsonp({ message: 'No file received in the `file` field' });

      const body = req.body || {};
      const result = {
        id: path.parse(req.file.filename).name,
        fileName: req.file.filename,
        originalName: req.file.originalname,
        url: publicUrl(req, req.file.filename),
        mimeType: req.file.mimetype,
        sizeBytes: req.file.size,
        category: body.category || null,
        employeeId: body.employeeId || null,
        title: body.title || req.file.originalname,
        uploadedAt: new Date().toISOString(),
      };

      // The audit middleware only sees json-server collections, so record this here.
      if (router && router.db) {
        const logs = router.db.get('auditLogs');
        if (logs.value()) {
          logs
            .push({
              id: `aud_up_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
              action: 'file.upload',
              entity: 'file',
              entityId: result.id,
              entityLabel: result.originalName,
              userId: req.auditUser ? req.auditUser.id : null,
              userEmail: req.auditUser ? req.auditUser.email : null,
              oldValue: null,
              newValue: { fileName: result.fileName, sizeBytes: result.sizeBytes, mimeType: result.mimeType },
              aiRunId: null,
              details: { category: result.category, employeeId: result.employeeId },
              ip: req.ip,
              userAgent: req.get('user-agent') || null,
              createdAt: result.uploadedAt,
            })
            .value();
          if (typeof req.scheduleDbWrite === 'function') req.scheduleDbWrite();
        }
      }

      return res.status(201).jsonp(result);
    });
  };
}

module.exports = { createUploadRoutes, UPLOAD_DIR, ALLOWED_TYPES, MAX_BYTES };
