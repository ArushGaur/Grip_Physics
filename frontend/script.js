/* ═══════════════════════════════════════════════════════════════
   VYORRA — marketing site interactions
   Vanilla JS, no dependencies. Respects reduced-motion.
   ═══════════════════════════════════════════════════════════════ */
(function () {
	"use strict";

	var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

	/* ── Current year ────────────────────────────────────────── */
	var yearEl = document.getElementById("year");
	if (yearEl) yearEl.textContent = String(new Date().getFullYear());

	/* ── Header shadow on scroll ─────────────────────────────── */
	var header = document.getElementById("siteHeader");
	function onScroll() {
		if (!header) return;
		header.classList.toggle("scrolled", window.scrollY > 8);
	}
	onScroll();
	window.addEventListener("scroll", onScroll, { passive: true });

	/* ── Mobile navigation ───────────────────────────────────── */
	var navToggle = document.getElementById("navToggle");
	var nav = document.getElementById("primaryNav");

	function setNav(open) {
		if (!nav || !navToggle) return;
		nav.classList.toggle("open", open);
		navToggle.setAttribute("aria-expanded", open ? "true" : "false");
		navToggle.setAttribute("aria-label", open ? "Close menu" : "Open menu");
	}

	if (navToggle && nav) {
		navToggle.addEventListener("click", function () {
			setNav(nav.classList.contains("open") === false);
		});
		nav.addEventListener("click", function (e) {
			if (e.target.tagName === "A") setNav(false);
		});
		document.addEventListener("keydown", function (e) {
			if (e.key === "Escape") setNav(false);
		});
		window.addEventListener("resize", function () {
			if (window.innerWidth > 760) setNav(false);
		});
	}

	/* ── Scroll reveal ───────────────────────────────────────── */
	var revealEls = Array.prototype.slice.call(document.querySelectorAll(".reveal"));

	if (reduceMotion || !("IntersectionObserver" in window)) {
		revealEls.forEach(function (el) { el.classList.add("in"); });
	} else {
		var revealObserver = new IntersectionObserver(function (entries) {
			entries.forEach(function (entry) {
				if (!entry.isIntersecting) return;
				var el = entry.target;
				var siblings = el.parentElement
					? Array.prototype.slice.call(el.parentElement.children).filter(function (n) {
						return n.classList && n.classList.contains("reveal");
					})
					: [];
				var idx = Math.max(0, siblings.indexOf(el));
				el.style.transitionDelay = Math.min(idx * 80, 320) + "ms";
				el.classList.add("in");
				revealObserver.unobserve(el);
			});
		}, { threshold: 0.12, rootMargin: "0px 0px -40px 0px" });

		revealEls.forEach(function (el) { revealObserver.observe(el); });
	}

	/* ── Animated counters ───────────────────────────────────── */
	var counters = Array.prototype.slice.call(document.querySelectorAll("[data-count]"));

	function formatValue(value, target) {
		return target >= 1000 ? Math.round(value).toLocaleString("en-IN") : String(Math.round(value));
	}

	function runCounter(el) {
		var target = parseFloat(el.getAttribute("data-count"));
		var suffix = el.getAttribute("data-suffix") || "";
		if (isNaN(target)) return;
		var duration = 1300;
		var started = null;

		function tick(now) {
			if (started === null) started = now;
			var p = Math.min((now - started) / duration, 1);
			var eased = 1 - Math.pow(1 - p, 3);
			el.textContent = formatValue(target * eased, target) + suffix;
			if (p < 1) requestAnimationFrame(tick);
		}
		requestAnimationFrame(tick);
	}

	if (!reduceMotion && "IntersectionObserver" in window) {
		var countObserver = new IntersectionObserver(function (entries) {
			entries.forEach(function (entry) {
				if (!entry.isIntersecting) return;
				runCounter(entry.target);
				countObserver.unobserve(entry.target);
			});
		}, { threshold: 0.6 });
		counters.forEach(function (el) { countObserver.observe(el); });
	}

	/* ── Active nav link on scroll ───────────────────────────── */
	var sectionIds = ["platform", "features", "workflow", "app", "pricing", "faq"];
	var sections = sectionIds
		.map(function (id) { return document.getElementById(id); })
		.filter(Boolean);
	var navLinks = {};
	sectionIds.forEach(function (id) {
		var link = document.querySelector('.nav a[href="#' + id + '"]');
		if (link) navLinks[id] = link;
	});

	if (sections.length && "IntersectionObserver" in window) {
		var navObserver = new IntersectionObserver(function (entries) {
			entries.forEach(function (entry) {
				var link = navLinks[entry.target.id];
				if (!link) return;
				if (entry.isIntersecting) {
					Object.keys(navLinks).forEach(function (k) { navLinks[k].classList.remove("active"); });
					link.classList.add("active");
				}
			});
		}, { rootMargin: "-45% 0px -50% 0px" });
		sections.forEach(function (s) { navObserver.observe(s); });
	}

	/* ── FAQ: keep one item open at a time ───────────────────── */
	var faqItems = Array.prototype.slice.call(document.querySelectorAll(".faq-list details"));
	faqItems.forEach(function (item) {
		item.addEventListener("toggle", function () {
			if (!item.open) return;
			faqItems.forEach(function (other) {
				if (other !== item) other.open = false;
			});
		});
	});

	/* ── Demo form ───────────────────────────────────────────── */
	/* Submissions are POSTed to /api/demo-requests and show up in the
	   owner panel's "Demo Requests" section. */
	var API_BASE = (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1")
		? ""
		: (window.location.hostname.endsWith(".github.io") ? "https://gripphysics-3gky0.sevalla.app" : "");

	var form = document.getElementById("demoForm");
	var note = document.getElementById("formNote");

	/* ── Thank-you popup ─────────────────────────────────────── */
	var thanksModal = document.getElementById("thanksModal");
	var thanksTitle = document.getElementById("thanksTitle");
	var thanksText = document.getElementById("thanksText");
	var lastFocused = null;

	function openThanks(name) {
		if (!thanksModal) return;

		if (thanksTitle) {
			var first = String(name || "").trim().split(/\s+/)[0];
			thanksTitle.textContent = first
				? "Thanks, " + first + " — request received!"
				: "Thanks — request received!";
		}
		if (thanksText) {
			thanksText.textContent =
				"Our team will call you within one working day to set up your 30-minute walkthrough.";
		}

		lastFocused = document.activeElement;
		thanksModal.hidden = false;
		document.body.style.overflow = "hidden";

		var cta = thanksModal.querySelector(".btn");
		if (cta) {
			try { cta.focus({ preventScroll: true }); } catch (err) { cta.focus(); }
		}
	}

	function closeThanks() {
		if (!thanksModal || thanksModal.hidden) return;
		thanksModal.hidden = true;
		document.body.style.overflow = "";
		if (lastFocused && typeof lastFocused.focus === "function") {
			try { lastFocused.focus({ preventScroll: true }); } catch (err) { lastFocused.focus(); }
		}
		lastFocused = null;
	}

	if (thanksModal) {
		/* Backdrop, the × button and "Got it" all close the popup. */
		thanksModal.addEventListener("click", function (e) {
			if (e.target.closest("[data-thanks-close]")) closeThanks();
		});

		/* Escape closes it; Tab stays inside the dialog. */
		document.addEventListener("keydown", function (e) {
			if (thanksModal.hidden) return;

			if (e.key === "Escape") {
				e.stopPropagation();
				closeThanks();
				return;
			}

			if (e.key !== "Tab") return;
			var focusable = thanksModal.querySelectorAll("button, a[href]");
			if (!focusable.length) return;
			var first = focusable[0];
			var last = focusable[focusable.length - 1];
			if (e.shiftKey && document.activeElement === first) {
				e.preventDefault();
				last.focus();
			} else if (!e.shiftKey && document.activeElement === last) {
				e.preventDefault();
				first.focus();
			}
		});
	}

	if (form && note) {
		form.addEventListener("submit", function (e) {
			e.preventDefault();
			var required = Array.prototype.slice.call(form.querySelectorAll("[required]"));
			var firstBad = null;

			required.forEach(function (field) {
				var value = String(field.value || "").trim();
				var bad = value.length < 2;
				if (field.type === "tel") bad = value.replace(/\D/g, "").length < 10;
				field.classList.toggle("invalid", bad);
				if (bad && !firstBad) firstBad = field;
			});

			if (firstBad) {
				note.textContent = "Please fill in your name, institute and a valid phone number.";
				note.className = "form-note err";
				firstBad.focus();
				return;
			}

			var button = form.querySelector('button[type="submit"]');
			if (button) {
				button.disabled = true;
				button.textContent = "Sending…";
			}
			note.textContent = "";
			note.className = "form-note";

			function release() {
				if (button) {
					button.disabled = false;
					button.textContent = "Request a demo";
				}
			}

			function val(id) {
				var el = document.getElementById(id);
				return el ? String(el.value || "").trim() : "";
			}

			var payload = {
				name: val("name"),
				institute: val("institute"),
				phone: val("phone"),
				students: val("students"),
				message: val("message")
			};

			fetch(API_BASE + "/api/demo-requests", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(payload)
			})
				.then(function (r) {
					return r.json().catch(function () { return {}; }).then(function (data) {
						return { ok: r.ok, data: data };
					});
				})
				.then(function (res) {
					release();
					if (!res.ok) {
						note.textContent = res.data.error || "Something went wrong. Please try again or call us.";
						note.className = "form-note err";
						return;
					}
					var submittedName = payload.name;
					form.reset();
					note.textContent = "Request received — we'll be in touch shortly.";
					note.className = "form-note ok";
					openThanks(submittedName);
				})
				.catch(function () {
					release();
					note.textContent = "Network error — please check your connection and try again.";
					note.className = "form-note err";
				});
		});

		form.addEventListener("input", function (e) {
			if (e.target.classList) e.target.classList.remove("invalid");
		});
	}
})();
