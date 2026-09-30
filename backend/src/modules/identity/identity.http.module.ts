import { Module } from "@nestjs/common";
import { InvitationsController, MeController, RolesController, UsersController } from "./identity.controllers";
import { IdentityModule } from "./identity.module";

/** Controllers of the identity module; api process only. */
@Module({
  imports: [IdentityModule],
  controllers: [MeController, UsersController, RolesController, InvitationsController],
})
export class IdentityHttpModule {}
