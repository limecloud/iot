package run.limeai.iot.television

import android.app.Activity
import android.content.Context
import android.content.res.ColorStateList
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.StateListDrawable
import android.view.Gravity
import android.view.FocusFinder
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.widget.*

/** 电视表现组件；不持有设备身份、授权或连接生命周期。 */
internal object TvUi {
    val background = Color.rgb(27, 29, 33)
    val surface = Color.argb(218, 27, 32, 40)
    val elevated = Color.argb(230, 46, 55, 68)
    val accent = Color.rgb(0, 114, 255)
    val text = Color.rgb(243, 243, 245)
    val muted = Color.rgb(190, 201, 215)
    val warning = Color.rgb(245, 201, 132)
    fun dp(context: Context, value: Int) = (value * context.resources.displayMetrics.density + .5f).toInt()

    fun shape(context: Context, fill: Int, stroke: Int = Color.TRANSPARENT, radius: Int = 8) = GradientDrawable().apply {
        setColor(fill); cornerRadius = dp(context, radius).toFloat()
        if (stroke != Color.TRANSPARENT) setStroke(dp(context, 2), stroke)
    }

    fun label(context: Context, value: String, size: Float = 16f, secondary: Boolean = false) = TextView(context).apply {
        text = value; textSize = size; setTextColor(if (secondary) muted else TvUi.text)
        includeFontPadding = false; setLineSpacing(dp(context, 3).toFloat(), 1f)
        importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_YES
    }

    fun column(context: Context, padding: Int = 0) = LinearLayout(context).apply {
        orientation = LinearLayout.VERTICAL
        setPadding(dp(context, padding), dp(context, padding), dp(context, padding), dp(context, padding))
        clipChildren = false; clipToPadding = false
    }

    fun card(context: Context, padding: Int = 20) = column(context, padding).apply {
        background = shape(context, surface)
    }

    fun space(context: Context, height: Int) = View(context).apply {
        layoutParams = LinearLayout.LayoutParams(1, dp(context, height))
        importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
    }

    fun states(context: Context, primary: Boolean = false) = StateListDrawable().apply {
        addState(intArrayOf(-android.R.attr.state_enabled), shape(context, Color.rgb(31, 32, 36)))
        addState(intArrayOf(android.R.attr.state_pressed), shape(context, Color.rgb(0, 103, 218), Color.WHITE))
        addState(intArrayOf(android.R.attr.state_focused), shape(context, accent, Color.WHITE))
        addState(intArrayOf(android.R.attr.state_selected), shape(context, Color.argb(180, 37, 83, 132)))
        addState(intArrayOf(), shape(context, if (primary) Color.rgb(240, 245, 252) else elevated))
    }

    fun styleButton(button: Button, primary: Boolean = false) {
        button.apply {
            if (id == View.NO_ID) id = View.generateViewId()
            isFocusable = true; isFocusableInTouchMode = false; isAllCaps = false
            textSize = 17f; typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
            includeFontPadding = false; minWidth = 0; minimumWidth = 0; minHeight = dp(context, 48)
            backgroundTintList = null; background = states(context, primary); stateListAnimator = null
            setPadding(dp(context, 18), dp(context, 10), dp(context, 18), dp(context, 10))
            setTextColor(ColorStateList(
                arrayOf(intArrayOf(-android.R.attr.state_enabled), intArrayOf(android.R.attr.state_focused), intArrayOf(android.R.attr.state_pressed), intArrayOf()),
                intArrayOf(Color.rgb(127, 137, 150), Color.WHITE, Color.WHITE, if (primary) TvUi.background else TvUi.text),
            ))
            setOnFocusChangeListener { view, focused ->
                view.animate().scaleX(if (focused) 1.025f else 1f).scaleY(if (focused) 1.025f else 1f).setDuration(120).start()
                view.elevation = if (focused) dp(context, 6).toFloat() else 0f
            }
        }
    }

    fun button(context: Context, value: String, primary: Boolean = false, action: () -> Unit) = Button(context).apply {
        text = value; styleButton(this, primary); setOnClickListener { action() }
        layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
            topMargin = dp(context, 8)
        }
    }

    /** API23的方向搜索仍可能选中禁用按钮；状态刷新后同步焦点资格。 */
    fun syncEnabledFocus(view: View) {
        if (view is Button) view.isFocusable = view.isEnabled
        if (view is ViewGroup) for (index in 0 until view.childCount) syncEnabledFocus(view.getChildAt(index))
    }

    /** 整张入口聚焦；图标、标题和实时摘要不拥有领域状态。 */
    fun actionTile(parent: LinearLayout, icon: Int, title: String, description: String, action: () -> Unit): TextView {
        val context = parent.context
        val row = LinearLayout(context).apply {
            id = View.generateViewId(); orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL
            minimumHeight = dp(context, 96); setPadding(dp(context, 18), dp(context, 16), dp(context, 14), dp(context, 16))
            isFocusable = true; isClickable = true
            background = StateListDrawable().apply {
                addState(intArrayOf(android.R.attr.state_pressed), shape(context, Color.rgb(0, 103, 218), Color.WHITE, 12))
                addState(intArrayOf(android.R.attr.state_focused), shape(context, accent, Color.WHITE, 12))
                addState(intArrayOf(), shape(context, Color.argb(146, 57, 72, 90), Color.argb(45, 255, 255, 255), 12))
            }
            contentDescription = "$title，$description"
            setOnClickListener { action() }
        }
        parent.addView(row, LinearLayout.LayoutParams(0, -1, 1f).apply {
            if (parent.childCount > 0) leftMargin = dp(context, 14)
        })
        row.addView(ImageView(context).apply {
            setImageResource(icon); importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
        }, LinearLayout.LayoutParams(dp(context, 28), dp(context, 28)).apply { rightMargin = dp(context, 16) })
        val copy = column(context)
        row.addView(copy, LinearLayout.LayoutParams(0, -2, 1f))
        copy.addView(label(context, title, 17f))
        copy.addView(label(context, description, 12f, true).apply { setPadding(0, dp(context, 5), 0, 0) })
        val value = label(context, "", 13f).apply { setPadding(0, dp(context, 6), 0, 0) }
        copy.addView(value)
        return value
    }
}

/** 横向导航和单页焦点；静态背景不参与设备状态或连接生命周期。 */
internal class TvNavigation(private val activity: Activity, private val onPageChanged: (Int) -> Unit = {}) {
    val root = object : FrameLayout(activity) {
        override fun dispatchKeyEvent(event: KeyEvent): Boolean {
            if (event.action == KeyEvent.ACTION_DOWN && event.keyCode == KeyEvent.KEYCODE_DPAD_UP) {
                val focused = findFocus()
                if (focused != null && withinContent(focused)) {
                    val next = FocusFinder.getInstance().findNextFocus(this, focused, View.FOCUS_UP)
                    if (next == null || !withinContent(next)) { focusNavigation(); return true }
                }
            }
            return super.dispatchKeyEvent(event)
        }
    }
    val notice = TvUi.label(activity, "", 14f).apply {
        setTextColor(TvUi.warning); visibility = View.GONE
        setPadding(0, 0, 0, TvUi.dp(activity, 10))
    }
    private val navigation = LinearLayout(activity).apply { orientation = LinearLayout.HORIZONTAL; clipChildren = false }
    private val content = FrameLayout(activity)
    private val title = TvUi.label(activity, "", 30f).apply { typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL) }
    private val subtitle = TvUi.label(activity, "", 15f, true)
    private val connection = TvUi.label(activity, "尚未配置", 13f, true)
    private val shade = View(activity).apply { setBackgroundColor(Color.BLACK) }
    private val pages = mutableListOf<Triple<String, String, View>>()
    private val buttons = mutableListOf<Button>()
    var selected = 0; private set

    init {
        root.setBackgroundColor(TvUi.background)
        root.addView(ImageView(activity).apply {
            setImageResource(R.drawable.tv_mountain_dusk); scaleType = ImageView.ScaleType.CENTER_CROP
            importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
        }, FrameLayout.LayoutParams(-1, -1))
        root.addView(View(activity).apply {
            background = GradientDrawable(GradientDrawable.Orientation.LEFT_RIGHT, intArrayOf(Color.argb(175, 7, 17, 30), Color.argb(10, 7, 17, 30)))
        }, FrameLayout.LayoutParams(-1, -1))
        root.addView(View(activity).apply {
            background = GradientDrawable(GradientDrawable.Orientation.BOTTOM_TOP, intArrayOf(Color.argb(215, 7, 17, 30), Color.TRANSPARENT))
        }, FrameLayout.LayoutParams(-1, -1))
        root.addView(shade, FrameLayout.LayoutParams(-1, -1))
        val shell = TvUi.column(activity).apply {
            setPadding(TvUi.dp(activity, 48), TvUi.dp(activity, 22), TvUi.dp(activity, 48), TvUi.dp(activity, 20))
        }
        root.addView(shell, FrameLayout.LayoutParams(-1, -1))
        val brand = LinearLayout(activity).apply { gravity = Gravity.CENTER_VERTICAL }
        brand.addView(TvUi.label(activity, "LimeIoT", 22f).apply { typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL) })
        brand.addView(TvUi.label(activity, "│  电视终端", 13f, true).apply { setPadding(TvUi.dp(activity, 14), 0, 0, 0) })
        brand.addView(View(activity), LinearLayout.LayoutParams(0, 1, 1f))
        brand.addView(connection)
        shell.addView(brand)
        shell.addView(navigation, LinearLayout.LayoutParams(-1, TvUi.dp(activity, 48)).apply {
            topMargin = TvUi.dp(activity, 18); bottomMargin = TvUi.dp(activity, 20)
        })
        shell.addView(title)
        shell.addView(subtitle, LinearLayout.LayoutParams(-1, -2).apply { topMargin = TvUi.dp(activity, 8); bottomMargin = TvUi.dp(activity, 16) })
        shell.addView(notice)
        shell.addView(content, LinearLayout.LayoutParams(-1, 0, 1f))
        val footer = LinearLayout(activity).apply { gravity = Gravity.CENTER_VERTICAL; setPadding(0, TvUi.dp(activity, 12), 0, 0) }
        footer.addView(TvUi.label(activity, "方向键移动     确定键选择     返回键回总览", 12f, true), LinearLayout.LayoutParams(0, -2, 1f))
        footer.addView(TvUi.label(activity, "${BuildConfig.VERSION_NAME}", 11f, true))
        shell.addView(footer)
    }

    fun addPage(label: String, heading: String, description: String, body: View) {
        val index = pages.size
        val scroll = ScrollView(activity).apply {
            isFillViewport = true; clipToPadding = false; clipChildren = false
            setPadding(TvUi.dp(activity, 4), TvUi.dp(activity, 4), TvUi.dp(activity, 4), TvUi.dp(activity, 8))
            isFocusable = false
            addView(body, ViewGroup.LayoutParams(-1, -2)); visibility = View.GONE
        }
        pages += Triple(heading, description, scroll)
        content.addView(scroll, FrameLayout.LayoutParams(-1, -1))
        val button = TvUi.button(activity, label) { show(index, true) }.apply {
            gravity = Gravity.CENTER
            setPadding(TvUi.dp(activity, 18), 0, TvUi.dp(activity, 18), 0)
            background = StateListDrawable().apply {
                addState(intArrayOf(android.R.attr.state_pressed), TvUi.shape(activity, Color.rgb(0, 103, 218), Color.WHITE, 24))
                addState(intArrayOf(android.R.attr.state_focused), TvUi.shape(activity, TvUi.accent, Color.WHITE, 24))
                addState(intArrayOf(android.R.attr.state_selected), TvUi.shape(activity, Color.argb(190, 25, 76, 130), radius = 24))
                addState(intArrayOf(), TvUi.shape(activity, Color.TRANSPARENT, radius = 24))
            }
            setOnFocusChangeListener { _, focused -> if (focused) show(index) }
            setOnKeyListener { _, key, event ->
                if (event.action != KeyEvent.ACTION_DOWN) false else when (key) {
                    KeyEvent.KEYCODE_DPAD_DOWN -> { show(index, true); true }
                    KeyEvent.KEYCODE_DPAD_LEFT -> { buttons.getOrNull(index - 1)?.requestFocus(); true }
                    KeyEvent.KEYCODE_DPAD_RIGHT -> { buttons.getOrNull(index + 1)?.requestFocus(); true }
                    KeyEvent.KEYCODE_DPAD_UP -> true
                    else -> false
                }
            }
        }
        buttons += button
        navigation.addView(button, LinearLayout.LayoutParams(TvUi.dp(activity, 126), -1).apply {
            if (index > 0) leftMargin = TvUi.dp(activity, 12)
        })
    }

    fun show(index: Int, focusContent: Boolean = false) {
        if (index !in pages.indices) return
        selected = index
        pages.forEachIndexed { i, (_, _, view) -> view.visibility = if (i == index) View.VISIBLE else View.GONE }
        buttons.forEachIndexed { i, button -> button.isSelected = i == index }
        title.text = pages[index].first; subtitle.text = pages[index].second
        title.visibility = if (index == 0) View.GONE else View.VISIBLE
        subtitle.visibility = title.visibility
        shade.alpha = if (index == 0) 0f else .78f
        onPageChanged(index)
        if (focusContent) firstFocusable(pages[index].third)?.requestFocus() ?: buttons[index].requestFocus()
    }

    fun focusNavigation() { buttons[selected].requestFocus() }
    fun status(value: String) { connection.text = value }
    fun message(value: String) { notice.text = value; notice.visibility = if (value.isBlank()) View.GONE else View.VISIBLE }

    private fun withinContent(view: View): Boolean {
        var current: android.view.ViewParent? = view.parent
        while (current != null) { if (current === content) return true; current = current.parent }
        return view === content
    }

    private fun firstFocusable(view: View): View? {
        if (view.visibility != View.VISIBLE) return null
        if (view !is ScrollView && view.isFocusable && view.isEnabled) return view
        if (view is ViewGroup) for (index in 0 until view.childCount) firstFocusable(view.getChildAt(index))?.let { return it }
        return null
    }
}
