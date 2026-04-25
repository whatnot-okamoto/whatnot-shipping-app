type Props = {
  bundleOrderUniqueKeys: string[];
  bundleEnabled: boolean;
};

export default function BundleGroupIndicator({ bundleOrderUniqueKeys, bundleEnabled }: Props) {
  const count = bundleOrderUniqueKeys.length;
  if (count <= 1) return null;

  if (bundleEnabled) {
    return (
      <span className="text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded font-medium">
        同梱：{count}件
      </span>
    );
  }

  return (
    <span className="text-xs bg-yellow-100 text-yellow-700 px-2 py-0.5 rounded font-medium">
      同梱フラグあり（未確定）
    </span>
  );
}
