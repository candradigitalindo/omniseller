import { Module } from "@nestjs/common";
import { DevicesRepository } from "./devices.repository";
import { DevicesService } from "./devices.service";
import { IdentityRepository, PreTenantLookup } from "./identity.repository";
import { InvitationsService } from "./invitations.service";
import { RolesService } from "./roles.service";
import { TenantsService } from "./tenants.service";
import { UsersService } from "./users.service";

const SERVICES = [
  IdentityRepository,
  PreTenantLookup,
  TenantsService,
  UsersService,
  RolesService,
  InvitationsService,
  DevicesRepository,
  DevicesService,
];

/** Services of the identity module; loaded by api and worker. */
@Module({ providers: SERVICES, exports: SERVICES })
export class IdentityModule {}
