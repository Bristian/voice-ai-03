/**
 * Vehicle — public-facing subset of the `vehicles` table.
 * Mirrors ../contracts/vehicle.schema.json.
 */

import { z } from "zod";

export const StatusSchema = z.enum(["available", "sold", "hold"]);
export type Status = z.infer<typeof StatusSchema>;

export const ConditionSchema = z.enum(["new", "used", "cpo"]);
export type Condition = z.infer<typeof ConditionSchema>;

export const VehicleSchema = z
  .object({
    vin: z.string().length(17),
    make: z.string(),
    model: z.string(),
    year: z.number().int().min(1900).max(2100),
    trim: z.string().nullable().optional(),
    color_ext: z.string().nullable().optional(),
    color_int: z.string().nullable().optional(),
    mileage: z.number().int().min(0).nullable().optional(),
    price: z.number().min(0),
    condition: ConditionSchema.nullable().optional(),
    transmission: z.string().nullable().optional(),
    fuel_type: z.string().nullable().optional(),
    body_style: z.string().nullable().optional(),
    features: z.array(z.string()).default([]),
    status: StatusSchema,
    description: z.string().nullable().optional(),
  })
  .strict();

export type Vehicle = z.infer<typeof VehicleSchema>;
