import 'dotenv/config';
export const env = {
  databaseUrl: process.env.DATABASE_URL ?? 'postgresql://vendor:vendor@localhost:5433/vendor_onboarding',
  port: Number(process.env.PORT ?? 4000),
  jwtSecret: process.env.JWT_SECRET ?? 'dev-secret',
  appBaseUrl: process.env.APP_BASE_URL ?? 'http://localhost:5173',
  devShowOtp: (process.env.DEV_SHOW_OTP ?? 'true') === 'true',
  uploadDir: process.env.UPLOAD_DIR ?? './uploads',
};
