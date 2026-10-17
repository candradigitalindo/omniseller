import { Module } from "@nestjs/common";
import { CommerceModule } from "../commerce/commerce.module";
import { CommerceInboxController } from "./commerce-inbox.controller";
import { CommerceInboxService } from "./commerce-inbox.service";
@Module({ imports: [CommerceModule], providers: [CommerceInboxService], controllers: [CommerceInboxController] })
export class CommerceInboxHttpModule {}
