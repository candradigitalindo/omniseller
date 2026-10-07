import { Module } from "@nestjs/common";
import { IdentityModule } from "../identity/identity.module";
import { NotificationInboxModule } from "../notification/notification.module";
import { BusinessDocumentsController, BusinessProfileController } from "./business.controller";
import { BusinessRepository } from "./business.repository";
import { BusinessProfileService } from "./business-profile.service";

const SERVICES = [BusinessRepository, BusinessProfileService];

/** The business profile and legal documents (api and worker); files come from the global FilesModule. */
@Module({ imports: [IdentityModule, NotificationInboxModule], providers: SERVICES, exports: SERVICES })
export class BusinessModule {}

@Module({ imports: [BusinessModule], controllers: [BusinessProfileController, BusinessDocumentsController] })
export class BusinessHttpModule {}
