package com.wzry.houdinihook;

public final class NativeInstall {
    private NativeInstall() {
    }

    public static native boolean install();

    public static native int state();
}
