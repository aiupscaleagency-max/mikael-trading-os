import 'dotenv/config';
import {z} from 'zod';
const env=z.object({
 ANTHROPIC_API_KEY:z.string().default(''),
 DEFAULT_POSITION_USD:z.coerce.number().positive().default(50),
 MIN_POSITION_USD:z.coerce.number().positive().default(20),
 MAX_POSITION_USD:z.coerce.number().positive().default(100),
 MAX_TOTAL_EXPOSURE_USD:z.coerce.number().positive().default(500),
 MAX_DAILY_LOSS_USD:z.coerce.number().positive().default(50),
 MAX_OPEN_POSITIONS:z.coerce.number().int().positive().default(5),
 MAX_DAILY_SPEND_USD:z.coerce.number().positive().default(2),
 MAX_WEEKLY_SPEND_USD:z.coerce.number().positive().default(10),
}).parse(process.env);
export const config={anthropicApiKey:env.ANTHROPIC_API_KEY,
 risk:{defaultPositionUsd:env.DEFAULT_POSITION_USD,minPositionUsd:env.MIN_POSITION_USD,maxPositionUsd:env.MAX_POSITION_USD,maxTotalExposureUsd:env.MAX_TOTAL_EXPOSURE_USD,maxDailyLossUsd:env.MAX_DAILY_LOSS_USD,maxOpenPositions:env.MAX_OPEN_POSITIONS},
 costCap:{dailyUsd:env.MAX_DAILY_SPEND_USD,weeklyUsd:env.MAX_WEEKLY_SPEND_USD}} as const;
export type Config=typeof config;
