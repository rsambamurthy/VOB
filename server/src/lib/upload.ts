import multer from 'multer';
import { HttpError } from './http.js';

const ALLOWED_MIME = ['application/pdf', 'image/png', 'image/jpeg'];

/** File uploads everywhere: held in memory (max 5 MB), checked and scanned, then written to the configured storage. */
export const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => (ALLOWED_MIME.includes(file.mimetype) ? cb(null, true) : cb(new HttpError(400, 'Only PDF, PNG or JPG files are allowed'))),
});

/** Spreadsheet uploads (imports): held in memory, max 5 MB; the importer checks it is a readable .xlsx. */
export const excelUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1 } });

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
/** Contract files and Word templates: PDF, images or Word .docx (max 10 MB); storeUpload checks the real contents. */
export const contractUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => ([...ALLOWED_MIME, DOCX_MIME].includes(file.mimetype) || /\.docx$/i.test(file.originalname) ? cb(null, true) : cb(new HttpError(400, 'Only Word (.docx), PDF, PNG or JPG files are allowed'))),
});
