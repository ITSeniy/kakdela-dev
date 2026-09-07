import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { env } from '../env.js'
import * as schema from '../db/schema.js'

export const sql = postgres(env.DATABASE_URL)
export const db = drizzle(sql, { schema })

export type DbExecutor = Pick<typeof db, 'select' | 'insert' | 'update' | 'delete' | 'execute'>
