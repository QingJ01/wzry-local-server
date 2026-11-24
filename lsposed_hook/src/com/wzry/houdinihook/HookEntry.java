package com.wzry.houdinihook;

import de.robv.android.xposed.IXposedHookLoadPackage;
import de.robv.android.xposed.XposedBridge;
import de.robv.android.xposed.callbacks.XC_LoadPackage;
import android.content.pm.ApplicationInfo;

public final class HookEntry implements IXposedHookLoadPackage {
    private static final String TARGET_PACKAGE = "com.tencent.tmgp.sgame";
    private static volatile boolean sAttempted = false;

    @Override
    public void handleLoadPackage(XC_LoadPackage.LoadPackageParam lpparam) throws Throwable {
        if (sAttempted) {
            return;
        }
        if (lpparam == null || !TARGET_PACKAGE.equals(lpparam.packageName)) {
            return;
        }
        sAttempted = true;
        XposedBridge.log("wzry_hook: handleLoadPackage for " + lpparam.packageName);
        // The installed module's extracted lib dir is resolved from its
        // base.apk path; System.load requires an absolute filesystem path.
        try {
            String soPath = resolveSoPath(lpparam);
            XposedBridge.log("wzry_hook: loading " + soPath);
            System.load(soPath);
        } catch (UnsatisfiedLinkError e) {
            XposedBridge.log("wzry_hook: payload load failed: " + e);
            throw e;
        }
        boolean installed = NativeInstall.install();
        XposedBridge.log("wzry_hook: install result=" + installed + " state=" + NativeInstall.state());
    }

    private static String resolveSoPath(XC_LoadPackage.LoadPackageParam lpparam) {
        // Module class loaders under LSPosed have a null ProtectionDomain,
        // so codeSource is unavailable. Derive the extracted lib dir from
        // the module's base.apk path reported by the package manager.
        String extracted = null;
        try {
            ClassLoader cl = HookEntry.class.getClassLoader();
            if (cl != null) {
                // dalvik.system.PathClassLoader holds the apk path in
                // 'pathList' → DexPathList.dexElements[] → path (BaseDexClassLoader).
                java.lang.reflect.Field pathListField = findField(cl, "pathList");
                if (pathListField != null) {
                    Object pathList = pathListField.get(cl);
                    java.lang.reflect.Field dexElementsField = findField(pathList, "dexElements");
                    if (dexElementsField != null) {
                        Object[] elements = (Object[]) dexElementsField.get(pathList);
                        for (Object el : elements) {
                            java.lang.reflect.Field pathField = findField(el, "path");
                            if (pathField == null) continue;
                            Object path = pathField.get(el);
                            if (path == null) continue;
                            java.io.File apk = new java.io.File(path.toString());
                            if (!apk.getName().equals("base.apk")) continue;
                            java.io.File libDir = new java.io.File(apk.getParentFile(), "lib/x86_64");
                            java.io.File so = new java.io.File(libDir, "libwzry_houdini_selfkill_hook.so");
                            if (so.exists()) {
                                extracted = so.getAbsolutePath();
                                break;
                            }
                        }
                    }
                }
            }
        } catch (Throwable t) {
            XposedBridge.log("wzry_hook: resolveSoPath reflection failed: " + t);
        }
        if (extracted != null) {
            return extracted;
        }
        // Last resort: /data/local/tmp requires the pushed file to be ours —
        // verify it exists and is the expected size before trusting it.
        java.io.File fallback = new java.io.File("/data/local/tmp/libwzry_houdini_selfkill_hook.so");
        if (fallback.exists() && fallback.length() > 4096) {
            XposedBridge.log("wzry_hook: using tmp fallback .so");
            return fallback.getAbsolutePath();
        }
        throw new UnsatisfiedLinkError("libwzry_houdini_selfkill_hook.so not found in module lib dir or /data/local/tmp");
    }

    private static java.lang.reflect.Field findField(Object obj, String name) {
        Class<?> c = obj instanceof Class ? (Class<?>) obj : obj.getClass();
        while (c != null) {
            try {
                java.lang.reflect.Field f = c.getDeclaredField(name);
                f.setAccessible(true);
                return f;
            } catch (NoSuchFieldException e) {
                c = c.getSuperclass();
            }
        }
        return null;
    }
}
