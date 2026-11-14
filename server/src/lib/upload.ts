import multer from 'multer';
import { HttpError } from './http.js';

const ALLOWED_MIME = ['application/pdf', 'image/png', 'image/jpeg'];

/** File uploads everywhere: held in memory (max 5 MB), checked and scanned, then written to the configured storage. */
export const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => (ALLOWED_MIME.includes(file.mimetype) ? cb(null, true) : cb(new HttpError(400, 'Only PDF, PNG or JPG files are allowed'))),
});
