/**
 * Jest global setup. Runs before any test module is imported, so the config
 * loader sees a complete `test` environment and never throws on missing creds.
 */
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/indeed_test';
process.env.DATABASE_SSL = 'false';
process.env.JWT_SECRET = 'test-secret';
process.env.AWS_ACCESS_KEY_ID = 'test';
process.env.AWS_SECRET_ACCESS_KEY = 'test';
process.env.AWS_S3_BUCKET = 'indeed-test';
process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
process.env.AFRICA_TALKING_API_KEY = 'test';
process.env.AFRICA_TALKING_USERNAME = 'sandbox';
process.env.OTP_EXPIRY_MINUTES = '10';
