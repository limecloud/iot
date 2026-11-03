package run.limeai.iot.television;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.os.SystemClock;
import android.widget.TextView;
import java.io.File;
import java.io.FileOutputStream;
import org.json.JSONObject;

/** 测试目标独立进程只依赖系统类，不借用被测应用的Kotlin运行库。 */
public final class RuntimeTargetActivity extends Activity {
    private void record(String kind) {
        try (FileOutputStream output = new FileOutputStream(new File(getFilesDir(), "runtime-launches.jsonl"), true)) {
            JSONObject entry = new JSONObject().put("delivery", kind)
                .put("created_elapsed_ms", SystemClock.elapsedRealtime());
            output.write((entry.toString() + "\n").getBytes("UTF-8"));
            output.getFD().sync();
        } catch (Exception failure) {
            throw new IllegalStateException("runtime activity evidence unavailable", failure);
        }
    }

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        record("create");
        TextView label = new TextView(this);
        label.setText("LimeIoT TV runtime fixture");
        label.setTextSize(24f);
        setContentView(label);
    }

    @Override public void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        record("new_intent");
    }
}
