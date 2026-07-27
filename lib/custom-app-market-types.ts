import type { CustomAppManifest, CustomAppPermission } from "./custom-app-types";

export type CustomAppReviewStatus = "pending" | "approved" | "rejected";

export type CustomAppPackageKind = "floatapp" | "zip" | "html";

export type CustomAppMarketItem = {
  id: string;
  appId: string;
  name: string;
  version: string;
  changelog?: string;
  authorId: string;
  authorName: string;
  authorAvatar?: string;
  description?: string;
  iconDataUrl?: string;
  permissions: CustomAppPermission[];
  manifest: CustomAppManifest;
  packageUrl: string;
  packagePath: string;
  packageKind: CustomAppPackageKind;
  packageSize: number;
  reviewStatus: CustomAppReviewStatus;
  installCount: number;
  likeCount: number;
  createdAt: string;
  updatedAt: string;
};
