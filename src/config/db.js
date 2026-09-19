import mongoose from 'mongoose';
import { env } from './env.js';

export async function connectDb() {
  await mongoose.connect(env.mongoUri, { serverSelectionTimeoutMS: 5000 });
  return mongoose.connection;
}

export const dbReady = () => mongoose.connection.readyState === 1;
