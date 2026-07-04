import { Injectable, NotFoundException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { normalizePlate } from '../common/util/plate';
import { DatabaseService } from '../db/database.service';
import { fleetTargets, grabTargets } from '../db/schema';
import { Platform } from '../import/import.types';

export interface UpsertGojekTarget {
  fleetTarget?: number;
  rentalPartner?: string;
  deliveryBatch?: string;
  serviceArea?: string;
  vehicleType?: string;
  regionId?: number;
}

export interface UpsertGrabTarget {
  rentalPartner?: string;
  vehicleType?: string;
  city?: string;
}

@Injectable()
export class TargetsService {
  constructor(private readonly database: DatabaseService) {}

  async get(platform: Platform, plate: string) {
    const norm = normalizePlate(plate);
    const { db } = this.database;
    if (platform === 'gojek') {
      const [row] = await db
        .select()
        .from(fleetTargets)
        .where(eq(fleetTargets.vehiclePlateNorm, norm));
      if (!row) throw new NotFoundException(`No target for plate ${norm}`);
      return row;
    }
    const [row] = await db.select().from(grabTargets).where(eq(grabTargets.plateNumber, norm));
    if (!row) throw new NotFoundException(`No target for plate ${norm}`);
    return row;
  }

  async upsertGojek(plate: string, input: UpsertGojekTarget) {
    const norm = normalizePlate(plate);
    const { db } = this.database;
    const [row] = await db
      .insert(fleetTargets)
      .values({ vehiclePlate: norm, vehiclePlateNorm: norm, ...input })
      .onConflictDoUpdate({
        target: fleetTargets.vehiclePlate,
        set: { ...input, vehiclePlateNorm: norm, updatedAt: new Date() },
      })
      .returning();
    return row;
  }

  async upsertGrab(plate: string, input: UpsertGrabTarget) {
    const norm = normalizePlate(plate);
    const { db } = this.database;
    const [row] = await db
      .insert(grabTargets)
      .values({ plateNumber: norm, ...input })
      .onConflictDoUpdate({
        target: grabTargets.plateNumber,
        set: { ...input, updatedAt: new Date() },
      })
      .returning();
    return row;
  }
}
