from django.contrib import messages
from django.shortcuts import redirect, render
from django.utils.translation import gettext as _, ngettext

from .forms import ApplicationForm


def apply(request):
    form = ApplicationForm(request.POST or None, request.FILES or None)
    if request.method == "POST" and form.is_valid():
        if "save" in request.POST:
            messages.success(request, _("Your application was saved. "))
            return redirect("dashboard")
        messages.success(request, _("We received your application."))
        return redirect("dashboard")
    return render(request, "applications/apply.html", {"form": form})


def dashboard(request):
    count = request.user.applications.count()
    summary = ngettext(
        "You have %(count)s application in progress.",
        "You have %(count)s applications in progress.",
        count,
    ) % {"count": count}
    return render(request, "accounts/home.html", {"summary": summary})


def receipt_line(total):
    # Translators: Label before the total amount, e.g. "Total: $120.00". Keep the trailing space.
    return _("Total: ") + total


def confirmation_email_body():
    return _("Hello,\n\nWe received your application. We will contact you within 10 business days.\n")
