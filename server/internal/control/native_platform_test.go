package control

import "testing"

func TestNativePlatforms(t *testing.T) {
	for _, platform := range []string{"ios", "android", "macos", "windows"} {
		if !nativePlatform(platform) {
			t.Fatalf("supported platform rejected: %s", platform)
		}
	}
	for _, platform := range []string{"", "web", "MacOS", "linux", "windows\n", "ios/android"} {
		if nativePlatform(platform) {
			t.Fatalf("unknown platform accepted: %q", platform)
		}
	}
}
