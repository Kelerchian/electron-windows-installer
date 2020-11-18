import * as asar from "asar";
import { createTempDir } from "./temp-utils";
import * as fs from "fs-extra";
import { Metadata, Options, PersonMetadata } from "./options";
import * as path from "path";
import template from "lodash.template";
import {
  useRCEdit,
  useNuget,
  useSyncReleases,
  useSquirrelCLI,
  getSquirrelWin32CLIPath,
} from "./vendor-bindings";

export { Options } from "./options";
const log = require("debug")("electron-windows-installer:main");

const DEFAULT_LOADING_GIF = path.join(
  __dirname,
  "..",
  "resources",
  "install-spinner.gif"
);

export function convertVersion(version: string): string {
  const parts = version.split("-");
  const mainVersion = parts.shift();

  if (parts.length > 0) {
    return [mainVersion, parts.join("-").replace(/\./g, "")].join("-");
  } else {
    return mainVersion as string;
  }
}

export async function createWindowsInstaller(options: Options): Promise<void> {
  let { appDirectory, outputDirectory, loadingGif } = options;
  outputDirectory = path.resolve(outputDirectory || "installer");

  const appSquirrelExePath = path.join(appDirectory, "Squirrel.exe");

  await fs.copy(getSquirrelWin32CLIPath(), appSquirrelExePath);
  if (options.setupIcon && options.skipUpdateIcon !== true) {
    await useRCEdit([appSquirrelExePath, "--set-icon", options.setupIcon]);
  }

  loadingGif = loadingGif ? path.resolve(loadingGif) : DEFAULT_LOADING_GIF;

  let {
    certificateFile,
    certificatePassword,
    remoteReleases,
    signWithParams,
    signTool,
    remoteToken,
  } = options;

  const metadata: Metadata = {
    description: "",
    iconUrl:
      "https://raw.githubusercontent.com/electron/electron/master/shell/browser/resources/win/electron.ico",
  };

  if (options.usePackageJson !== false) {
    const appResources = path.join(appDirectory, "resources");
    const asarFile = path.join(appResources, "app.asar");
    let appMetadata;

    if (await fs.pathExists(asarFile)) {
      appMetadata = JSON.parse(asar.extractFile(asarFile, "package.json"));
    } else {
      appMetadata = await fs.readJson(
        path.join(appResources, "app", "package.json")
      );
    }

    Object.assign(
      metadata,
      {
        exe: `${appMetadata.name}.exe`,
        title: appMetadata.productName || appMetadata.name,
      },
      appMetadata
    );
  }

  Object.assign(metadata, options);

  if (!metadata.authors) {
    if (typeof metadata.author === "string") {
      metadata.authors = metadata.author;
    } else {
      // eslint-disable-next-line @typescript-eslint/no-object-literal-type-assertion
      metadata.authors = (metadata.author || ({} as PersonMetadata)).name || "";
    }
  }

  metadata.owners = metadata.owners || metadata.authors;
  metadata.version = convertVersion(metadata.version as string);
  metadata.copyright =
    metadata.copyright ||
    `Copyright © ${new Date().getFullYear()} ${
      metadata.authors || metadata.owners
    }`;

  let templateData = await fs.readFile(
    path.join(__dirname, "..", "template.nuspectemplate"),
    "utf8"
  );
  if (path.sep === "/") {
    templateData = templateData.replace(/\\/g, "/");
  }
  const nuspecContent = template(templateData)(metadata);

  log(`Created NuSpec file:\n${nuspecContent}`);

  const nugetOutput = await createTempDir("si-");
  const targetNuspecPath = path.join(nugetOutput, metadata.name + ".nuspec");

  await fs.writeFile(targetNuspecPath, nuspecContent);

  // Call NuGet to create our package
  log(
    await useNuget([
      "pack",
      targetNuspecPath,
      "-BasePath",
      appDirectory,
      "-OutputDirectory",
      nugetOutput,
      "-NoDefaultExcludes",
    ])
  );

  if (remoteReleases) {
    log(
      await useSyncReleases(
        (() => {
          switch (true) {
            case !!remoteToken:
              return [
                "-u",
                remoteReleases,
                "-r",
                outputDirectory,
                "-t",
                remoteToken as string,
              ];
            default:
              return ["-u", remoteReleases, "-r", outputDirectory];
          }
        })()
      )
    );
  }

  const nupkgPath = path.join(
    nugetOutput,
    `${metadata.name}.${metadata.version}.nupkg`
  );

  const releaseArgs = [
    "--releasify",
    nupkgPath,
    "--releaseDir",
    outputDirectory,
    "--loadingGif",
    loadingGif,
  ];

  (() => {
    switch (signTool) {
      case "osslsigncode": {
        if (signWithParams) {
          return releaseArgs.push("--signWithParams", signWithParams);
        }

        if (certificateFile && certificatePassword) {
          return releaseArgs.push(
            "--signWithParams",
            `-pkcs12 "${path.resolve(
              certificateFile
            )}" -pass "${certificatePassword}"`
          );
        }
        break;
      }
      default: {
        if (
          signWithParams &&
          signWithParams.includes("/f") &&
          signWithParams.includes("/p")
        ) {
          return releaseArgs.push("--signWithParams", signWithParams);
        }

        if (signWithParams && certificateFile && certificatePassword) {
          return releaseArgs.push(
            "--signWithParams",
            `${signWithParams} /a /f "${path.resolve(
              certificateFile
            )}" /p "${certificatePassword}"`
          );
        }

        if (certificateFile && certificatePassword) {
          return releaseArgs.push(
            "--signWithParams",
            `/a /f "${path.resolve(
              certificateFile
            )}" /p "${certificatePassword}"`
          );
        }
        break;
      }
    }
  })();

  if (signTool) {
    releaseArgs.push("--signTool", signTool);
  }

  if (options.setupIcon) {
    releaseArgs.push("--setupIcon");
    releaseArgs.push(path.resolve(options.setupIcon));
  }

  if (options.noMsi) {
    releaseArgs.push("--no-msi");
  }

  if (options.noDelta) {
    releaseArgs.push("--no-delta");
  }

  if (options.frameworkVersion) {
    releaseArgs.push("--framework-version");
    releaseArgs.push(options.frameworkVersion);
  }

  log(await useSquirrelCLI(releaseArgs));

  if (options.fixUpPaths !== false) {
    log("Fixing up paths");

    if (metadata.productName || options.setupExe) {
      const setupPath = path.join(
        outputDirectory,
        options.setupExe || `${metadata.productName}Setup.exe`
      );
      const unfixedSetupPath = path.join(outputDirectory, "Setup.exe");
      log(`Renaming ${unfixedSetupPath} => ${setupPath}`);
      await fs.rename(unfixedSetupPath, setupPath);
    }

    if (metadata.productName || options.setupMsi) {
      const msiPath = path.join(
        outputDirectory,
        options.setupMsi || `${metadata.productName}Setup.msi`
      );
      const unfixedMsiPath = path.join(outputDirectory, "Setup.msi");
      if (await fs.pathExists(unfixedMsiPath)) {
        log(`Renaming ${unfixedMsiPath} => ${msiPath}`);
        await fs.rename(unfixedMsiPath, msiPath);
      }
    }
  }
}
