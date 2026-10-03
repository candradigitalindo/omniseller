import { type DynamicModule, Global, Module } from "@nestjs/common";
import type { EnvFor } from "../../config/env.schema";
import { FILE_STORAGE, fileStorageFor } from "./file-storage";
import { FilesController } from "./files.controller";
import { FilesRepository } from "./files.repository";
import { FilesService } from "./files.service";

/** Private files for api (downloads) and worker (labels, documents, cleanup). */
@Global()
@Module({})
export class FilesModule {
  static forEnv(env: EnvFor<"api"> | EnvFor<"worker">): DynamicModule {
    return {
      module: FilesModule,
      providers: [{ provide: FILE_STORAGE, useValue: fileStorageFor(env) }, FilesRepository, FilesService],
      exports: [FILE_STORAGE, FilesService],
    };
  }
}

@Module({ controllers: [FilesController] })
export class FilesHttpModule {}
