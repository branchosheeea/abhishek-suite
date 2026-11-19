"""Entry point: python -m vessel_report"""
from .ui import main

if __name__ == "__main__":
    from suite_services.access.guard import require_module
    require_module("vessel")
    main()
